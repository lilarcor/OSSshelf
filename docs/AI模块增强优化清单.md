# OSSshelf AI 模块增强 & 优化清单

> 基于当前代码库全面审查，按优先级分级。  
> **P0** = 影响正确性或核心体验 / **P1** = 明显提升 / **P2** = 进阶功能

---

## 一、AI 对话（AgentEngine）

### P0 — 必须修

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 1 | **工具调用解析脆弱** | `agentEngine.ts` | 当前依赖 ` ```tool_call ``` ` 正则，模型稍微格式偏差就解析失败。应升级为 OpenAI native function calling（`tools` 参数），在 `openAiCompatibleAdapter.ts` 里加 `tool_choice: "auto"` 支持，同时保留 prompt-based 作为 Workers AI 的 fallback |
| 2 | **对话历史注入位置错误** | `agentEngine.ts` L68 | `historyWithoutCurrent` 用 `slice(0, -1)` 剔除最后一条，但最后一条是 `user` 当前消息，不是 assistant。应改为只传 `assistant`/`user` 的历史轮次，当前 query 单独作为末尾 user 消息 |
| 3 | **Agent 循环用非流式 LLM** | `agentEngine.ts` | `chatCompletion`（非流式）做 tool 决策，首 token 要等全部内容生成才显示。工具决策轮应该也用流式，检测到 ` ```tool_call ``` ` 就立即终止并执行，减少感知延迟 |
| 4 | **Workers AI 不支持 native tool calling** | `workersAiAdapter.ts` | 适配器声明了 `function_calling` capability，但实际 `run()` 调用没有传 `tools` 参数。应在适配器层区分：支持 native tools 则传 OpenAI 格式 tools；否则走 prompt-based |

### P1 — 重要提升

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 5 | **无上下文范围限定** | `aiChatRoutes.ts` | 没有"只问这个文件夹"或"只针对这几个文件"的 scoped 对话。应在 `chatSchema` 加 `scopeFolderId?: string` / `scopeFileIds?: string[]`，AgentEngine 据此过滤工具查询范围 |
| 6 | **Agent 写操作工具缺失** | `agentTools.ts` | 当前 8 个工具全是只读。高价值的写操作工具：`rename_file`（智能重命名）、`add_tag`（打标签）、`move_file`（移动到文件夹）、`create_folder`。写操作需要前端二次确认弹窗 |
| 7 | **文件内容 Q&A 缺失** | `agentTools.ts` | 没有 `read_file_content` 工具，AI 无法回答"这个 PDF 里第几页说了什么"。应加 `get_file_content` 工具，对已 AI 索引的文件返回摘要+分段内容 |
| 8 | **会话标题自动生成质量差** | `aiChatRoutes.ts` L373 | 新建会话 title 直接 `query.slice(0, 50)`，截断效果差（如"帮我找最近上传"）。应用 LLM 对首条消息生成 8-12 字的总结标题，异步完成不阻塞响应 |
| 9 | **Token 用量未统计到流式回复** | `aiChatRoutes.ts` | 流式保存时 `tokenCount: Math.ceil(fullText.length * 0.5)` 是估算。应在 `done` chunk 里携带实际 token 数（OpenAI adapter 已有 usage，Workers AI 可从响应头读），写入 `ai_chat_messages.token_count` |
| 10 | **对话历史长度无限增长** | `agentEngine.ts` | 当前最多保留 8 条历史，但没有 token 预算控制。长对话后 context 会爆。应按 token 数（估算 chars×0.5）动态裁剪，保留最近的消息，始终留出 2048 token 给 completion |

### P2 — 进阶功能

| # | 功能点 | 说明 |
|---|--------|------|
| 11 | **对话导出** | 支持将一个 session 导出为 Markdown / PDF，当前没有任何导出接口 |
| 12 | **消息编辑** | 用户可编辑已发送的消息并重新生成（类似 ChatGPT 的 edit message），需要 session 分叉逻辑 |
| 13 | **多轮追问中引用具体文件** | 支持在输入框 `@filename` 语法，将该文件 ID 作为 mandatory context 传给 AgentEngine |
| 14 | **AI 对话快捷入口** | 在文件右键菜单/详情页加"向 AI 提问"按钮，带 `scopeFileId` 进入新对话，跳过工具搜索直接 Q&A |

---

## 二、向量索引（vectorIndex.ts）

### P0

| # | 问题 | 说明 |
|---|------|------|
| 15 | **无分块（Chunking）** | 文件内容直接 `slice(0, 4096)` 截断，超过 4096 字符的文件后半段完全不在索引里。应实现滑动窗口分块（chunk size: 512 token，overlap: 64 token），每块独立 upsert，Vectorize 支持一个文件对应多个向量（用 `fileId_chunk_N` 作 ID） |
| 16 | **搜索只取 TopK，无重排** | `searchAndFetchFiles` 直接返回余弦相似度最高的 K 个，没有 rerank。应在向量召回后对结果用 BM25 或 LLM cross-encoder 做二次排序，提升精度 |

### P1

| # | 问题 | 说明 |
|---|------|------|
| 17 | **大文件无法索引** | `buildFileTextForVector` 对图片/PDF 等二进制文件没有内容提取，只能索引文件名+摘要。PDF 应接入 Cloudflare AI 的 OCR 或第三方解析；Office 文件需服务端解析 |
| 18 | **索引版本不对齐** | 文件更新后只有手动重新索引才能更新向量。应在文件 `updatedAt` 变化或内容 hash 变化时自动触发重新索引（利用现有 Queues 机制） |
| 19 | **混合检索权重不可配置** | 当前语义搜索和关键词搜索（LIKE）是硬编码 fallback，不是并行加权合并（Hybrid Search）。应实现 RRF（Reciprocal Rank Fusion）合并两路结果 |

---

## 三、AI 功能模块（features.ts）

### P1

| # | 问题 | 说明 |
|---|------|------|
| 20 | **摘要 Prompt 过于简单** | 当前 system prompt 只有 3 句话，无结构化输出格式。应按文件类型定制 prompt：代码文件→函数列表+主要逻辑；文档→摘要+关键点；表格→数据概述+字段说明 |
| 21 | **图片 Caption 语言不一致** | `callVisionModel` 传的 prompt 是英文，要求"respond in same language"，但系统整体是中文。应统一要求中文 caption 输出 |
| 22 | **批处理任务无断点续传** | 批量索引/摘要中途失败后，已处理的文件不会被跳过，重新启动会全部重来。应在 KV task 里记录 `processedFileIds: Set`，续跑时跳过已成功的 |
| 23 | **摘要缓存 key 设计有缺陷** | `cacheKey = ai:summary:${fileId}:${file.hash || file.updatedAt}` — `updatedAt` 会因为其他字段更新（如打标签）而变化，导致摘要缓存频繁失效。应改为只用内容 hash |

### P2

| # | 功能点 | 说明 |
|---|--------|------|
| 24 | **文档对比功能** | 选中两个文件，AI 对比差异（版本变化、内容异同），适合文档管理场景 |
| 25 | **自动分类建议** | 上传文件后 AI 建议放入哪个文件夹（基于内容与现有目录结构的相似度） |
| 26 | **批量摘要导出** | 将一个文件夹下所有文件的摘要导出为一个 Markdown 索引文件 |

---

## 四、模型网关（modelGateway.ts）

### P1

| # | 问题 | 说明 |
|---|------|------|
| 27 | **无重试机制** | LLM 调用失败直接抛错，没有 exponential backoff 重试。对于网络抖动导致的 502/503，应重试 2-3 次 |
| 28 | **Adapter 缓存无过期** | `adapterCache: Map` 在 Worker 生命周期内永不清除，若用户更新了模型配置（新 API key），旧 adapter 依然被使用直到 Worker 实例重启。应在 `parseAndDecryptModelConfig` 后加版本 hash 到缓存 key |
| 29 | **无超时控制** | `chatCompletion` 没有 timeout，模型卡住会让 Worker 一直等到超时（30s CPU limit）。应加 `Promise.race` + 20s AbortController |
| 30 | **不支持 Anthropic 原生 API** | `types.ts` 定义了 `'anthropic'` provider 但 `modelGateway.ts` 只有 `workers_ai` 和 `openai_compatible` 两个 case，使用 Anthropic API 时会抛 "Unsupported provider" 错误。应补全 Anthropic adapter |

### P2

| # | 功能点 | 说明 |
|---|--------|------|
| 31 | **Token 用量统计 Dashboard** | 汇总每个模型的 token 消耗、费用估算，存入 D1，在 AI 设置页展示趋势图 |
| 32 | **模型路由规则** | 支持按功能类型路由到不同模型：摘要用便宜小模型，对话用强模型，embedding 用专用模型，降低成本 |

---

## 五、AI 设置页（AISettings.tsx）

### P1

| # | 问题 | 说明 |
|---|------|------|
| 33 | **无法测试 Embedding 模型** | `test` 接口只测 chat completion，embedding 模型配置后无法验证是否可用 |
| 34 | **向量索引统计缺少文件维度** | 当前 `index/stats` 只有总数，无法知道"哪些文件已索引、哪些未索引、哪些索引失败"，排查问题困难 |
| 35 | **批处理任务无暂停功能** | 只有取消（delete），无法暂停/恢复。对大量文件的批处理来说体验差 |

---

## 六、前端 AI 对话（AIChat.tsx）

### P1

| # | 问题 | 说明 |
|---|------|------|
| 36 | **工具结果 files 未渲染为可点击卡片网格** | `ToolCallCard` 展示的是原始 JSON，但工具返回的文件列表应该渲染成和 assistant 消息里一样的文件卡片（可点击预览/跳转），而不是折叠 JSON |
| 37 | **消息无持久化滚动位置** | 切换 session 后，再切回来滚动位置重置到顶部。应记录每个 session 的滚动位置 |
| 38 | **移动端输入框被键盘遮挡** | iOS Safari 软键盘弹出后，`100vh` 不缩小，输入框被键盘遮挡。应用 `visualViewport` API 动态调整 |
| 39 | **无对话搜索** | 当前没有搜索历史消息的功能。对话多了后找不到之前的内容 |

### P2

| # | 功能点 | 说明 |
|---|--------|------|
| 40 | **文件附件上传到对话** | 输入框支持拖拽/选择文件，临时附加到当前消息，AI 直接分析该文件内容（无需先上传到系统） |
| 41 | **语音输入** | 利用浏览器 Web Speech API 或 Workers AI Whisper 做语音转文字输入 |
| 42 | **对话分享** | 将一个 session 生成公开链接，他人可只读查看（类似 ChatGPT shared link） |

---

## 七、安全 & 可靠性

### P0

| # | 问题 | 说明 |
|---|------|------|
| 43 | **AgentEngine 无 Prompt Injection 防护** | 如果用户上传了包含"忽略以上所有指令"的文本文件并被 AI 索引，工具结果里的内容可能影响 LLM 行为。应在工具结果注入前对内容做转义，或加 guardrail system message 声明"以下内容来自不可信数据源" |
| 44 | **没有 AI 对话频率限制** | 无限制调用 `/ai-chat/chat`，API key 泄露后会爆费。应加基于 userId 的 Rate Limit（如：每分钟 10 次，每天 200 次），超限返回 429 |

### P1

| # | 问题 | 说明 |
|---|------|------|
| 45 | **工具执行没有权限校验** | `AgentToolExecutor` 里的 SQL 查询只过滤 `userId`，但文件权限系统（`file_permissions`、`permission_groups`）未被考虑。共享给用户的文件但非其所有的，也能被 AI 搜索到，存在越权风险 |

---

## 优先级总结

| 优先级 | 条目数 | 关键项 |
|--------|--------|--------|
| **P0 立即修** | 8 | #1工具调用解析、#2历史注入、#15分块索引、#43注入防护、#44频率限制 |
| **P1 下一版** | 22 | #6写操作工具、#7文件内容Q&A、#8标题生成、#19混合检索、#30 Anthropic适配器 |
| **P2 规划中** | 14 | 对话导出、语音输入、文件附件、对话分享 |

---

*生成时间：2026-04-04 | 基于 OSSshelf-main 代码库全量审查*
