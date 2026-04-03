# OSSShelf 修复与拓展指引

> 基于代码审查（2025年）整理，共 **9 个问题**，按优先级排列。  
> 每条包含：根因、改动位置、完整代码片段或 diff，可直接照抄。

---

## P0 — Bug 修复（影响现有功能正确性）

### #1 上传文件不触发 AI 自动处理

**根因**

`/files/upload`（表单上传，用户最常用的路径）末尾没有调用 `autoProcessFile`。
只有 `/files/create`（直接创建文本文件）有这个调用，导致绝大多数上传文件永远不会自动生成摘要、图片标签、向量索引。

**改动位置**

`apps/api/src/routes/files.ts` → `app.post('/upload', ...)` 路由末尾，在 `return c.json(...)` 之前插入。

**代码**

```typescript
// 在 return c.json({ success: true, data: { ... } }) 之前插入：
c.executionCtx.waitUntil(
  (async () => {
    try {
      if (await isAIConfigured(c.env)) {
        await autoProcessFile(c.env, fileId);
      }
    } catch (error) {
      logger.error('FILES', '自动处理文件失败', { fileId }, error);
    }
  })()
);
```

> `isAIConfigured` 和 `autoProcessFile` 已在文件顶部 import，无需新增依赖。

---

### #2 一键索引漏掉无摘要的旧文件

**根因**

`runBatchIndexTask` 的查询条件包含 `isNotNull(files.aiSummary)`，导致通过 upload 上传、从未生成过摘要的文件（即历史存量文件）被完全跳过，一键索引对它们无效。

`buildFileTextForVector` 在无摘要时可以退化到只用文件名做向量，不需要强制要求有摘要。

**改动位置**

`apps/api/src/routes/ai.ts` → `runBatchIndexTask` 函数内的 DB 查询。

**diff**

```diff
 const allUnindexed = await db
   .select({ id: files.id })
   .from(files)
   .where(
     and(
       eq(files.userId, userId),
       isNull(files.deletedAt),
       eq(files.isFolder, false),
-      isNull(files.vectorIndexedAt),
-      isNotNull(files.aiSummary)
+      isNull(files.vectorIndexedAt)
     )
   )
   .all();
```

> 同时删除文件顶部 `isNotNull` 的 import（如果删完后没有其他地方使用的话）。

---

## P1 — 功能缺失（已有基础设施，只差接线）

### #3 Webhook 从未被真实触发

**根因**

`dispatchWebhook` 在整个项目只被调用了一次——`webhooks.ts` 的手动测试端点（302行）。
`files.ts`、`share.ts` 里的上传、删除、分享创建等操作全部没有触发 Webhook，导致用户配置的 Webhook 永远收不到自动通知。

**改动位置一**：`apps/api/src/routes/files.ts`

在文件顶部 import 中添加：
```typescript
import { dispatchWebhook } from '../lib/webhook';
```

在 `app.post('/upload', ...)` 的 `sendNotification(...)` 调用之后插入（fire-and-forget，不阻塞响应）：
```typescript
c.executionCtx.waitUntil(
  dispatchWebhook(c.env, userId, 'file.uploaded', {
    fileId,
    fileName: uploadFile.name,
    size: uploadFile.size,
    mimeType: fileMime,
    bucketId: finalBucketId,
  })
);
```

在 `app.delete('/:id', ...)` 的 `sendNotification(...)` 之后插入：
```typescript
c.executionCtx.waitUntil(
  dispatchWebhook(c.env, userId, 'file.deleted', {
    fileId,
    fileName: file.name,
    isFolder: file.isFolder,
  })
);
```

在 `app.put('/:id/content', ...)` 末尾 `return c.json(...)` 之前插入：
```typescript
c.executionCtx.waitUntil(
  dispatchWebhook(c.env, userId, 'file.updated', {
    fileId,
    fileName: file.name,
    size: newSize,
  })
);
```

**改动位置二**：`apps/api/src/routes/share.ts`

在 `app.post('/', ...)` 创建分享成功后的 `return c.json(...)` 之前插入：
```typescript
c.executionCtx.waitUntil(
  dispatchWebhook(c.env, userId, 'share.created', {
    shareId: shareId,
    fileId: body.fileId,
    expiresAt: body.expiresAt,
  })
);
```

> `dispatchWebhook` 已有完整的 HMAC 签名、重试、日志，无需修改 lib。

---

### #4 已登录用户无法批量下载/ZIP 自己的文件

**根因**

ZIP 打包端点 `GET /api/share/:id/zip` 只属于公开分享流程，必须持有 shareId。
已登录用户在文件列表多选后，后端没有对应的批量下载接口，前端无法实现这个功能。
`ZipBuilder` 和 `collectFolderFiles` 已经存在，只差一个 authenticated 路由。

**改动位置**：`apps/api/src/routes/batch.ts`

在文件顶部 import 添加：
```typescript
import { ZipBuilder } from '../lib/zipStream';
import { s3Get } from '../lib/s3client';
import { resolveBucketConfig } from '../lib/bucketResolver';
import { getEncryptionKey } from '../lib/crypto';
```

在文件末尾 `export default app` 之前添加路由：

```typescript
// ── POST /api/files/batch/zip ──────────────────────────────────────────────
const batchZipSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(100),
  zipName: z.string().max(100).optional(),
});

app.post('/zip', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = batchZipSchema.safeParse(body);
  if (!result.success) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } },
      400
    );
  }

  const { fileIds, zipName = 'download' } = result.data;
  const db = getDb(c.env.DB);
  const encKey = getEncryptionKey(c.env);

  // 限制：最多 100 个文件，总大小不超过 500MB
  const MAX_ZIP_BYTES = 500 * 1024 * 1024;

  const fileRecords = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        isNull(files.deletedAt),
        eq(files.isFolder, false),
        inArray(files.id, fileIds)
      )
    )
    .all();

  const totalBytes = fileRecords.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_ZIP_BYTES) {
    return c.json(
      {
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: `ZIP 总大小不超过 500MB，当前 ${(totalBytes / 1024 / 1024).toFixed(1)}MB`,
        },
      },
      400
    );
  }

  const zip = new ZipBuilder();

  for (const file of fileRecords) {
    try {
      const bucketConfig = await resolveBucketConfig(db, userId, encKey, file.bucketId, file.parentId);
      let buf: ArrayBuffer;
      if (bucketConfig) {
        const res = await s3Get(bucketConfig, file.r2Key);
        buf = await res.arrayBuffer();
      } else if (c.env.FILES) {
        const obj = await c.env.FILES.get(file.r2Key);
        if (!obj) continue;
        buf = await obj.arrayBuffer();
      } else {
        continue;
      }
      zip.addFile(file.name, buf, new Date(file.updatedAt));
    } catch {
      // 单个文件失败不中止整个 ZIP
      continue;
    }
  }

  const zipBytes = zip.finalize();
  return new Response(zipBytes, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}.zip`,
      'Content-Length': zipBytes.length.toString(),
    },
  });
});
```

**前端调用**（`apps/web/src/services/api.ts` 的 batchApi 对象中添加）：
```typescript
zip: (fileIds: string[], zipName?: string) =>
  axios.post(
    `${API_BASE}/files/batch/zip`,
    { fileIds, zipName },
    { responseType: 'blob' }
  ).then(res => {
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${zipName || 'download'}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }),
```

---

## P2 — 能力拓展（基础设施已就绪，补完整闭环）

### #5 跨文件 AI 问答（RAG）

**根因**

向量库（Vectorize）已建好，bge-m3 embedding 已跑通，`searchSimilarFiles` 已实现。
现在只有"搜索返回文件列表"，缺"把检索结果送入 LLM 生成自然语言答案"这一步，即 RAG 的 generate 端。

**改动位置**：`apps/api/src/routes/ai.ts`

在现有路由末尾（`export default app` 之前）添加：

```typescript
// ── POST /api/ai/chat ──────────────────────────────────────────────────────
const chatSchema = z.object({
  query: z.string().min(1).max(500),
  scope: z.enum(['all', 'folder']).default('all'),
  folderId: z.string().optional(), // scope=folder 时生效
  limit: z.number().int().min(1).max(10).default(5),
});

app.post('/chat', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = chatSchema.safeParse(body);
  if (!result.success) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } },
      400
    );
  }

  if (!c.env.AI || !c.env.VECTORIZE) {
    return c.json(
      { success: false, error: { code: 'AI_NOT_CONFIGURED', message: 'AI 功能未配置' } },
      503
    );
  }

  const { query, limit } = result.data;

  // 1. 向量检索
  const similar = await searchAndFetchFiles(c.env, query, userId, { limit, threshold: 0.4 });

  if (similar.length === 0) {
    return c.json({
      success: true,
      data: {
        answer: '在您的文件中没有找到与此问题相关的内容。',
        sources: [],
      },
    });
  }

  // 2. 组装上下文
  const context = similar
    .map((f, i) => {
      const parts = [`[${i + 1}] 文件名：${f.name}`];
      if (f.aiSummary) parts.push(`摘要：${f.aiSummary}`);
      if (f.description) parts.push(`描述：${f.description}`);
      return parts.join('\n');
    })
    .join('\n\n');

  // 3. LLM 生成答案
  const response = await (c.env.AI as any).run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content:
          '你是文件助手。根据提供的文件信息回答用户问题。回答要简洁准确，并在末尾用"来源：[序号]"注明引用了哪些文件。如果文件信息不足以回答问题，请如实说明。',
      },
      {
        role: 'user',
        content: `用户问题：${query}\n\n相关文件信息：\n${context}`,
      },
    ],
    max_tokens: 500,
  });

  const answer = (response as { response?: string }).response?.trim() || '无法生成回答，请重试。';

  return c.json({
    success: true,
    data: {
      answer,
      sources: similar.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        score: f.similarityScore,
      })),
    },
  });
});
```

**前端入口建议**：在搜索框增加"问答模式"切换，或在 AI 设置页新增独立的"文件问答"卡片，调用 `POST /api/ai/chat`。

---

### #6 通知实时推送（SSE）

**根因**

`NotificationBell` 当前靠 5 秒定时轮询 `GET /api/notifications?unreadOnly=true` 获取未读数。
Cloudflare Workers 原生支持 SSE（Server-Sent Events），可以让服务端主动推送，无需轮询，延迟从 ~5s 降到实时。

**改动位置一**：`apps/api/src/routes/notifications.ts`，添加 SSE 端点：

```typescript
// GET /api/notifications/stream  — SSE 长连接，推送未读数变化
app.get('/stream', async (c) => {
  const userId = c.get('userId')!;
  const db = getDb(c.env.DB);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: object) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // 立即发送当前未读数
  const countResult = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)))
    .get();
  send({ unreadCount: countResult?.count ?? 0 });

  // 每 30 秒心跳（保持连接 + 顺带更新计数）
  const interval = setInterval(async () => {
    try {
      const r = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)))
        .get();
      send({ unreadCount: r?.count ?? 0 });
    } catch {
      clearInterval(interval);
      writer.close();
    }
  }, 30000);

  c.req.raw.signal.addEventListener('abort', () => {
    clearInterval(interval);
    writer.close();
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
```

**改动位置二**：`apps/web/src/components/notifications/NotificationBell.tsx`，替换轮询为 SSE：

```typescript
// 替换现有的 useQuery 轮询逻辑
useEffect(() => {
  const es = new EventSource(`${API_BASE}/notifications/stream`, {
    withCredentials: true,
  });
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (typeof data.unreadCount === 'number') {
      setUnreadCount(data.unreadCount);
    }
  };
  es.onerror = () => es.close();
  return () => es.close();
}, []);
```

> SSE 需要 token 鉴权。如果前端用 Cookie 鉴权可直接用 `withCredentials: true`；如果用 Bearer Token，需改为手动 `fetch` + `ReadableStream` 读取，并在请求头带上 `Authorization`。

---

### #7 AI 设置页：旧文件一键批量生成摘要（可编辑文件）

**根因**

`/api/ai/summarize/:fileId` 只支持单文件，AI 设置页没有批量入口。
历史存量的可编辑文件（txt/md/json/ts/html 等）没有 `aiSummary`，直接跑一键索引只能索引文件名，语义质量很低。
正确流程是：先批量补摘要 → 再一键索引，这样向量内容才有意义。

**什么是可编辑文件**

`mimeType` 匹配 `text/*` / `application/json` / `application/xml` / `application/javascript` / `application/yaml`，
或扩展名属于 `txt md json js ts tsx html css yaml yml toml sh` 等（完整列表见 `packages/shared/src/constants/index.ts` 的 `EDITABLE_EXTENSIONS`）。

**后端改动**：`apps/api/src/routes/ai.ts`

新增两个端点，追加到 `export default app` 之前：

1. `POST /api/ai/summarize/batch`  
   查询条件：`userId = 当前用户 AND deletedAt IS NULL AND isFolder = false AND aiSummary IS NULL`，在应用层用 `canGenerateSummary(mimeType, name)` 过滤出可编辑文件，并发5个调用 `generateFileSummary`，每批写 KV 进度（key = `ai:summarize:task:{userId}`，TTL 24h），结构与 `IndexTask` 相同。

2. `GET /api/ai/summarize/task`  
   读取 `ai:summarize:task:{userId}` 返回任务状态，无任务时返回 `{ status: 'idle' }`。

**前端改动**：`apps/web/src/services/api.ts` → `aiApi` 对象中添加

```typescript
summarizeBatch: () => api.post('/api/ai/summarize/batch'),
getSummarizeTask: () => api.get('/api/ai/summarize/task'),
```

---

### #8 AI 设置页：旧文件一键批量生成标签+描述（图片）

**根因**

与 #7 同理。历史图片没有 `aiTags`，向量内容只有文件名，语义极差。
需要先跑图片标签+描述（LLaVA + ResNet），再一键索引。

**后端改动**：`apps/api/src/routes/ai.ts`

新增两个端点，追加到 `export default app` 之前：

1. `POST /api/ai/tags/batch`  
   查询条件：`userId = 当前用户 AND deletedAt IS NULL AND isFolder = false AND aiTags IS NULL AND mimeType LIKE 'image/%'`，并发5个调用 `generateImageTags`，每批写 KV 进度（key = `ai:tags:task:{userId}`，TTL 24h）。

2. `GET /api/ai/tags/task`  
   读取 `ai:tags:task:{userId}` 返回任务状态。

**前端改动**：`apps/web/src/services/api.ts` → `aiApi` 对象中添加

```typescript
tagsBatch: () => api.post('/api/ai/tags/batch'),
getTagsTask: () => api.get('/api/ai/tags/task'),
```

---

### #9 AI 设置页：分类索引状态统计面板

**根因**

当前 AI 设置页没有任何数据展示，用户不知道哪些文件已索引、哪些还没处理。
需要按三类分开展示，帮助用户决定下一步操作。

**三类定义**

| 类型 | 判断条件 | 可做的 AI 处理 |
|------|---------|--------------|
| 可编辑文件 | `canGenerateSummary(mimeType, name) === true` | 生成摘要 → 索引 |
| 图片 | `mimeType.startsWith('image/')` | 生成标签+描述 → 索引 |
| 其他文件 | 以上两者都不是 | 直接索引文件名 |

**后端改动**：`apps/api/src/routes/ai.ts`

新增端点，追加到 `export default app` 之前：

`GET /api/ai/index/stats`  
一次性查出当前用户所有非删除非文件夹的文件，在应用层分类统计，返回结构：

```typescript
{
  editable: { total: number, noSummary: number, notIndexed: number },
  image:    { total: number, noTags: number,    notIndexed: number },
  other:    { total: number, notIndexed: number }
}
```

- `noSummary`：`aiSummary IS NULL`
- `noTags`：`aiTags IS NULL`
- `notIndexed`：`vectorIndexedAt IS NULL`

**前端改动**：`apps/web/src/services/api.ts` → `aiApi` 对象中添加

```typescript
getIndexStats: () => api.get<ApiResponse<AIIndexStats>>('/api/ai/index/stats'),
```

**前端展示**（`AISettings.tsx`）

在"语义搜索索引"卡片上方新增统计区域，三列并排展示：

- **可编辑文件**：显示 total / noSummary 未生成摘要 / notIndexed 未索引，配"一键生成摘要"按钮（触发 #7）
- **图片**：显示 total / noTags 未生成标签 / notIndexed 未索引，配"一键生成标签"按钮（触发 #8）
- **其他文件**：显示 total / notIndexed 未索引（无额外 AI 操作，由一键索引直接处理）

每次任务完成后刷新统计。统计数据轮询间隔与任务状态同步（任务运行中 5s 刷一次，空闲时 30s 刷一次）。

**推荐操作流程提示**（页面顶部加一段说明文字）：

> 建议顺序：① 对可编辑文件生成摘要 → ② 对图片生成标签 → ③ 执行一键索引。完成后语义搜索效果最佳。

---

## 改动汇总

| # | 优先级 | 文件 | 改动量 | 说明 |
|---|--------|------|--------|------|
| 1 | P0 Bug | `routes/files.ts` | +8 行 | upload 触发 autoProcessFile |
| 2 | P0 Bug | `routes/ai.ts` | -1 行 | 一键索引去掉 aiSummary 过滤 |
| 3 | P1 缺失 | `routes/files.ts` `routes/share.ts` | +20 行 | Webhook 真实触发 |
| 4 | P1 缺失 | `routes/batch.ts` + 前端 api.ts | +60 行 | 批量 ZIP 下载 |
| 5 | P2 拓展 | `routes/ai.ts` | +60 行 | 跨文件 RAG 问答 |
| 6 | P2 拓展 | `routes/notifications.ts` + 前端 | +40 行 | SSE 实时推送 |
| 7 | P2 拓展 | `routes/ai.ts` + 前端 api.ts | +50 行 | 批量生成可编辑文件摘要 |
| 8 | P2 拓展 | `routes/ai.ts` + 前端 api.ts | +50 行 | 批量生成图片标签+描述 |
| 9 | P2 拓展 | `routes/ai.ts` + `AISettings.tsx` | +80 行 | 分类索引状态统计面板 |

**建议顺序**：#1 → #2 → #7 → #8（先把数据质量修好） → #9（统计面板依赖前面数据）→ #3 → #4 → #5 → #6
