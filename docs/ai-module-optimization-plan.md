# OSSshelf AI 模块优化大纲

> 基于代码审查报告，按执行顺序排列。每项包含：问题根因 → 改动范围 → 验收标准。

---

## Phase 1 — 高优先级 Bug Fix（建议优先执行）

### 1.1 修复 Prompt-Based 模式空转判断逻辑不一致

**根因**：Native 和 Prompt-Based 两条路径的 `idleRounds` 判断标准不同。Prompt-Based 只有 `result.error` 才算空转，导致返回空对象 `{}` 的工具被误判为有效，LLM 可能无限重试。

**改动范围**：`agentEngine.ts` → `runPromptBased()`

```diff
- const isErrorResult = (result as any)?.error !== undefined;
- if (isErrorResult) {
+ const roundNewData = mergeSourcesFromResult(result, sources);
+ if (!roundNewData) {
    idleRounds++;
    if (idleRounds >= config.maxIdleRounds) break;
  } else {
    idleRounds = 0;
  }
```

**验收**：工具连续返回 `{}` 或无文件结果时，Agent 在 `maxIdleRounds` 轮后正常退出。

---

### 1.2 修复 confirmId 消费非原子问题 + 清理过期记录

**根因**：`consumePendingConfirm` 先 SELECT 再 UPDATE，非原子操作，并发双击理论上可消费两次。过期记录无清理机制，表持续增长。

**改动范围**：`agentEngine.ts` → `consumePendingConfirm()`；`routes/cron.ts`

**具体改动**：

1. 将消费改为单条原子 SQL：

```sql
UPDATE ai_confirm_requests
SET status = 'consumed'
WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?
RETURNING *
```

通过 `changes` 或 `RETURNING` 判断是否成功消费，消除 SELECT + UPDATE 的竞态。

2. 在 cron 路由中添加清理任务（建议每日执行）：

```sql
DELETE FROM ai_confirm_requests
WHERE status IN ('expired', 'consumed')
  AND created_at < datetime('now', '-7 days')
```

**验收**：并发两次 confirm 请求，只有一次返回成功；数据库中 7 天前的已处理记录被定期清理。

---

### 1.3 修复 Native Fallback 时已流出内容重复问题

**根因**：`runNative` 捕获 LLM 错误后调用 `runPromptBased()`，此时 `fullText` 可能已有内容流到前端，fallback 重新生成后追加，前端出现重复文本。

**改动范围**：`agentEngine.ts` → `runNative()` catch 块；`AgentChunk` 类型

**具体改动**：

1. 新增 `reset` chunk 类型：

```typescript
| { type: 'reset'; done: false }
```

2. fallback 前发送 reset 信号：

```typescript
// 仅在第 0 轮（尚未产生任何工具调用）才允许 fallback
if (toolCallCount === 0) {
  if (fullText.length > 0) {
    onChunk({ type: 'reset', done: false }); // 通知前端清空
    fullText = '';
  }
  return this.runPromptBased(...);
} else {
  // 已有工具调用轮次，不 fallback，直接报错
  onChunk({ type: 'error', message: 'AI 模型调用失败', done: true });
  return { fullText, sources };
}
```

3. 前端 `AIChat.tsx` 处理 `reset` chunk：清空当前 assistant 消息已渲染内容。

**验收**：Native 模式第一轮失败时，前端不出现重复文本；已有工具调用后失败，直接展示错误。

---

## Phase 2 — 性能优化

### 2.1 loadAgentConfig 串行查询改并发 + 进程级缓存

**根因**：5 个 `getAiConfigNumber` 串行执行，无缓存，每次对话重新查询 D1，最多浪费 ~100ms。

**改动范围**：`agentEngine.ts` → `loadAgentConfig()`

```typescript
// 改前：串行
const maxToolCalls = await getAiConfigNumber(env, 'ai.agent.max_tool_calls', ...);
const maxIdleRounds = await getAiConfigNumber(env, 'ai.agent.max_idle_rounds', ...);
// ...

// 改后：并发 + WeakMap 缓存（与 ragEngine 的 intentCache 模式一致）
const agentConfigCache = new WeakMap<object, { data: AgentConfig; expiresAt: number }>();
const AGENT_CONFIG_TTL_MS = 5 * 60 * 1000;

async function loadAgentConfig(env: Env): Promise<AgentConfig> {
  const cached = agentConfigCache.get(env);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [maxToolCalls, maxIdleRounds, agentTemperature, imageTimeoutMs, maxContextTokens] =
    await Promise.all([
      getAiConfigNumber(env, 'ai.agent.max_tool_calls', DEFAULT_MAX_TOOL_CALLS),
      getAiConfigNumber(env, 'ai.agent.max_idle_rounds', DEFAULT_MAX_IDLE_ROUNDS),
      getAiConfigNumber(env, 'ai.agent.temperature', DEFAULT_AGENT_TEMPERATURE),
      getAiConfigNumber(env, 'ai.agent.image_timeout_ms', DEFAULT_IMAGE_TIMEOUT_MS),
      getAiConfigNumber(env, 'ai.agent.max_context_tokens', DEFAULT_MAX_CONTEXT_TOKENS),
    ]);

  const config = { maxToolCalls, maxIdleRounds, agentTemperature, imageTimeoutMs, maxContextTokens };
  agentConfigCache.set(env, { data: config, expiresAt: Date.now() + AGENT_CONFIG_TTL_MS });
  return config;
}
```

**验收**：同一 Worker 实例内第二次对话不触发 D1 查询（日志确认）；5 分钟后缓存失效重新加载。

---

### 2.2 工具集动态裁剪：按意图注入最小工具子集

**根因**：每次对话将全部 83 个工具（估算 ~6000 tokens）注入 LLM，浪费 token 且降低 LLM 决策精度。

**改动范围**：`agentEngine.ts`；新建 `agentTools/toolSelector.ts`

**具体改动**：

1. 新建 `toolSelector.ts`，定义工具分组：

```typescript
export const TOOL_GROUPS = {
  search:    ['search_files', 'filter_files', 'search_by_tag', 'search_duplicates', 'smart_search', 'get_similar_files'],
  content:   ['read_file_text', 'analyze_image', 'compare_files', 'content_preview', 'extract_metadata', 'generate_summary', 'generate_tags'],
  nav:       ['list_folder', 'get_folder_tree', 'navigate_path', 'get_storage_overview'],
  stats:     ['get_storage_stats', 'get_activity_stats', 'get_user_quota_info', 'get_file_type_distribution'],
  write:     ['create_text_file', 'create_code_file', 'edit_file_content', 'append_to_file',
              'find_and_replace', 'rename_file', 'move_file', 'copy_file', 'delete_file',
              'restore_file', 'create_folder', 'batch_rename', 'star_file', 'unstar_file'],
  tags:      ['add_tag', 'remove_tag', 'get_file_tags', 'merge_tags', 'auto_tag_files', 'tag_folder'],
  share:     ['create_share', 'list_shares', 'update_share', 'revoke_share', 'create_direct_link'],
  version:   ['get_file_versions', 'restore_version', 'compare_versions'],
  notes:     ['write_note', 'get_file_notes', 'update_note', 'delete_note'],
  system:    ['get_system_status', 'get_help', 'get_user_profile', 'list_api_keys'],
} as const;

// 按意图返回工具名称集合
export function selectTools(intent: QueryIntent, query: string): string[] {
  const base = [...TOOL_GROUPS.search, ...TOOL_GROUPS.nav];
  switch (intent) {
    case 'file_stats':   return [...base, ...TOOL_GROUPS.stats];
    case 'image_visual': return [...base, ...TOOL_GROUPS.content];
    case 'content_qa':   return [...base, ...TOOL_GROUPS.content, ...TOOL_GROUPS.notes];
    case 'file_search':  return [...base, ...TOOL_GROUPS.content];
    default:             return [...base, ...TOOL_GROUPS.stats, ...TOOL_GROUPS.system];
  }
}

// 写意图检测（含 write 组）
const WRITE_INTENT_PATTERNS = /创建|新建|编辑|修改|删除|移动|重命名|复制|打标|分享|备注/;
export function needsWriteTools(query: string): boolean {
  return WRITE_INTENT_PATTERNS.test(query);
}
```

2. 在 `AgentEngine.run()` 中做意图预判并过滤 TOOL_DEFINITIONS：

```typescript
const intent = await classifyIntent(this.env, query); // 复用 ragEngine 的分类器
const selectedNames = new Set([
  ...selectTools(intent, query),
  ...(needsWriteTools(query) ? [...TOOL_GROUPS.write, ...TOOL_GROUPS.tags, ...TOOL_GROUPS.share] : []),
]);
const filteredTools = TOOL_DEFINITIONS.filter(t => selectedNames.has(t.function.name));
```

**验收**：普通搜索问答工具数量从 83 降到约 20；写操作问答才注入 write 组；LLM 选工具准确率主观评估有提升。

---

## Phase 3 — 架构改进

### 3.1 修复 Agent 模式向量检索失效问题

**根因**：`stream=true`（Agent 路径）完全跳过 ragEngine，语义向量检索只在 RAG 路径生效，`smart_search` / `search_files` 工具只走关键词。

**改动范围**：`agentTools/search.ts` → `smart_search` 工具实现；`agentEngine.ts` 可选预注入

**方案 A（推荐）：工具层直接接入向量检索**

在 `smart_search` 工具内部同时执行关键词搜索和向量语义搜索，合并结果去重后返回：

```typescript
// agentTools/search.ts — smart_search 实现
const [keywordResults, vectorResults] = await Promise.all([
  // 现有关键词搜索
  searchFilesByKeyword(env, userId, query, { limit: 10 }),
  // 新增语义向量搜索
  searchAndFetchFiles(env, query, userId, { limit: 10, threshold: 0.6 }),
]);

// 合并去重，向量结果打分更高
const merged = mergeAndDedup([
  ...vectorResults.map(f => ({ ...f, score: f.score * 1.2 })),
  ...keywordResults.map(f => ({ ...f, score: 0.8 })),
]);
```

**方案 B（可选）：AgentEngine 预注入 RAG 上下文**

在 `AgentEngine.run()` 入口，当意图为 `content_qa` 时，预先执行 RAG 检索并将结果注入 system message：

```typescript
if (intent === 'content_qa') {
  const ragCtx = await ragEngine.buildContext({ query, userId });
  systemPrompt += `\n\n[预检索上下文]\n${ragCtx.assembledPrompt}`;
}
```

**验收**：Agent 模式下语义相关文件（如"找关于合同的文件"）能通过向量检索命中，不依赖文件名包含关键词。

---

### 3.2 agentTools 工具层改为委托 services 层

**根因**：`fileops.ts`、`share.ts`、`permission.ts` 直接操作 DB/S3，与 `fileService.ts`、`shareService.ts` 存在逻辑重复，权限检查不一致。

**改动范围**：`agentTools/fileops.ts`、`agentTools/share.ts`、`agentTools/permission.ts`

**原则**：工具层只做参数解析 → 调用 service → 格式化返回值，禁止直接写 SQL 或调用 S3 client。

```typescript
// 改前（工具直接操作 DB）
const db = getDb(env.DB);
await db.update(files).set({ name: newName }).where(eq(files.id, fileId));

// 改后（委托 service）
await fileService.renameFile(env, { fileId, newName, userId });
```

**验收**：工具执行结果与通过 REST API 操作结果一致；删除工具层中所有直接 SQL 调用。

---

### 3.3 Agent 模式补充 token / 工具调用次数追踪

**根因**：`handleStreamChat` 不记录 `modelUsed`、token 消耗、工具调用次数，无法排查成本与行为问题。

**改动范围**：`agentEngine.ts` 返回值；`routes/aiChatRoutes.ts` → `handleStreamChat()`

**具体改动**：

1. `AgentEngine.run()` 返回值新增字段：

```typescript
return {
  fullText,
  sources,
  pendingConfirmId,
  meta: {
    toolCallCount,
    modelId: resolvedModelId,
    // token 计数由 modelGateway 的流式回调累计
    inputTokens: tokenAccumulator.input,
    outputTokens: tokenAccumulator.output,
  }
};
```

2. stream 结束后写入 session 记录：

```typescript
await db.update(aiSessions).set({
  lastModelId: meta.modelId,
  lastToolCallCount: meta.toolCallCount,
  totalTokensUsed: sql`total_tokens_used + ${meta.inputTokens + meta.outputTokens}`,
}).where(eq(aiSessions.id, sessionId));
```

**验收**：AI 设置页 Sessions 列表能展示每次对话的模型和 token 消耗；日志中可查到工具调用次数。

---

## Phase 4 — 新功能

### 4.1 目录上下文注入（"在哪个文件夹提问"）

**价值**：用户在文件页面浏览某文件夹时，AI 能感知当前位置，搜索结果优先在此目录内。

**改动范围**：前端 `AIChat.tsx`、`Files.tsx`；后端 `aiChatRoutes.ts`；`agentEngine.ts`

**实现步骤**：

1. 前端：文件页面右键菜单新增"对此文件夹提问"入口，携带 `contextFolderId` 跳转到 AI 对话页；`AIChat.tsx` 接收并展示"当前上下文：/照片/2024"提示条。

2. 后端：chat 请求 body 新增可选字段：

```typescript
contextFolderId?: string;   // 优先搜索此文件夹
contextFileIds?: string[];  // 附加已选中文件作为上下文
```

3. AgentEngine：将上下文信息注入 system message：

```
[当前工作目录] 用户正在浏览文件夹 ID: {folderId}（路径：{folderPath}）。
搜索和列出操作应优先在此目录内进行，除非用户明确要求全局搜索。
```

**验收**：携带 `contextFolderId` 发起对话，Agent 的 `list_folder` 和 `search_files` 默认在该目录内执行。

---

### 4.2 文件编辑操作 Diff 预览

**价值**：`edit_file_content`、`find_and_replace` 等写操作在用户确认前展示 before/after 对比，大幅降低误操作风险。

**改动范围**：`agentTools/fileops.ts`；前端 `ToolCallCard.tsx`

**实现步骤**：

1. 后端：写操作的 `pending_confirm` 返回值中附带 diff 预览：

```typescript
// pending_confirm 结果新增字段
{
  status: 'pending_confirm',
  previewDiff: {
    before: originalContent.slice(0, 500), // 前 500 字符预览
    after: newContent.slice(0, 500),
    totalChanges: editCount,
  }
}
```

2. 前端 `ToolCallCard.tsx`：检测 `previewDiff` 字段存在时，在确认按钮上方渲染简易 diff 视图（新增行绿色背景，删除行红色背景，使用 `diff` 库计算）。

**验收**：对文本文件执行 `find_and_replace` 后，确认卡显示具体改动内容；用户点击"确认"后改动生效。

---

### 4.3 异步长任务 Agent（后台执行重型操作）

**价值**：批量重命名 / 整理数百个文件等操作不再受 30 秒请求超时限制，支持后台执行 + 进度推送。

**改动范围**：`aiTaskQueue.ts`；`routes/tasks.ts`；新增 `routes/agentTask.ts`；前端 Tasks 页面

**实现步骤**：

1. 用户发起涉及批量操作的对话（如"帮我整理 /照片 下所有文件"），Agent 判断操作量超过阈值（如 > 20 个文件）时，自动切换为异步模式。

2. 创建 `ai_agent_task` 类型的 Task，将已 confirmed 的工具调用序列写入 Queue：

```typescript
await env.AI_QUEUE.send({
  type: 'agent_batch',
  taskId,
  userId,
  operations: confirmedOps, // 已展开的写操作列表
});
```

3. Queue Consumer 逐条执行，原子更新 D1 中的 task 进度（复用现有 `aiTasks` 表 SQL 原子自增模式）。

4. 前端 Tasks 页面展示进度条，支持用户主动取消（设置 `status = 'cancelled'`，Consumer 轮询检查）。

**验收**：批量操作 100 个文件时请求立即返回并给出 taskId；Tasks 页面实时更新进度；取消后已执行的操作不回滚（文档说明），未执行的停止。

---

### 4.4 对话记忆摘要（超长会话上下文压缩）

**价值**：当前历史截断会丢失早期关键信息，摘要方案保留对话连贯性。

**改动范围**：`agentEngine.ts` → `buildHistory()`；DB schema 新增 `ai_sessions.contextSummary` 字段

**实现步骤**：

1. DB 迁移：`ai_sessions` 表新增 `context_summary TEXT` 字段。

2. `buildHistory()` 改造：历史超过 token 阈值（如 6000 tokens）时，触发摘要生成：

```typescript
// 后台异步生成摘要（不阻塞当前对话）
if (totalTokens > SUMMARY_THRESHOLD && !session.contextSummary) {
  generateSummaryAsync(env, sessionId, msgs); // 写入 context_summary 字段
}

// 加载已有摘要作为历史前缀
if (session.contextSummary) {
  return [
    { role: 'system', content: `[对话历史摘要]\n${session.contextSummary}` },
    ...recentMsgs, // 保留最近 N 条完整消息
  ];
}
```

3. 摘要提示词：要求 LLM 提取"用户关注的文件/文件夹、已执行的操作、待完成事项"等结构化信息，控制在 300 tokens 以内。

**验收**：超过 50 轮对话的 session，再次打开时能正确引用早期提到的文件名；摘要生成不阻塞当前对话响应速度。

---

### 4.5 Webhook 触发 Agent（文件事件自动化）

**价值**：文件上传 → 自动打 AI 标签 / 提取信息，无需手动触发，实现"智能文件夹"体验。

**改动范围**：`routes/webhooks.ts`；新建 `lib/ai/agentAutomation.ts`；前端 AI 设置页新增 Automation tab

**实现步骤**：

1. DB 新增 `ai_automations` 表：

```sql
CREATE TABLE ai_automations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trigger_event TEXT NOT NULL,  -- 'file.upload' | 'file.update'
  trigger_folder_id TEXT,       -- NULL = 全局，非 NULL = 指定文件夹
  action_prompt TEXT NOT NULL,  -- 用户配置的 Agent 指令
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
```

2. `routes/webhooks.ts` 文件上传事件处理器中检查是否有匹配的 automation：

```typescript
const automations = await getMatchingAutomations(env, userId, folderId);
for (const auto of automations) {
  await env.AI_QUEUE.send({
    type: 'agent_automation',
    userId,
    fileId: uploadedFile.id,
    prompt: auto.actionPrompt,
  });
}
```

3. Queue Consumer 以无前端交互模式运行 AgentEngine（跳过 confirm 流程，直接执行写操作），结果通过 notification 推送。

4. 前端：AI 设置页新增 Automation tab，支持配置触发条件和 Agent 指令（如"为上传到此文件夹的图片生成 AI 标签，并在备注中写入拍摄场景描述"）。

**验收**：向指定文件夹上传图片后 1 分钟内，文件自动获得 AI 标签；notification 中有执行结果推送。

---

## 执行顺序建议

| 阶段 | 任务 | 优先级 | 预估工作量 |
|---|---|---|---|
| Phase 1 | 1.1 空转判断统一 | P0 | 0.5h |
| Phase 1 | 1.2 confirm 原子消费 + cron 清理 | P0 | 2h |
| Phase 1 | 1.3 Native fallback 重复文本修复 | P1 | 1h |
| Phase 2 | 2.1 loadAgentConfig 并发 + 缓存 | P1 | 1h |
| Phase 2 | 2.2 工具集动态裁剪 | P1 | 3h |
| Phase 3 | 3.1 Agent 向量检索接入 | P1 | 3h |
| Phase 3 | 3.3 Token / 工具调用追踪 | P2 | 2h |
| Phase 3 | 3.2 工具层委托 services | P2 | 4h |
| Phase 4 | 4.1 目录上下文注入 | P2 | 3h |
| Phase 4 | 4.2 Diff 预览 | P2 | 3h |
| Phase 4 | 4.3 异步长任务 Agent | P3 | 8h |
| Phase 4 | 4.4 对话记忆摘要 | P3 | 4h |
| Phase 4 | 4.5 Webhook 触发 Agent | P3 | 8h |

> P0 = 影响正确性，立即修；P1 = 影响质量 / 性能，本迭代修；P2 = 体验改进；P3 = 新功能，排期执行。
