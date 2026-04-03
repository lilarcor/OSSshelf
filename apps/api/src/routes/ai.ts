/**
 * ai.ts
 * AI 功能路由
 *
 * 功能:
 * - 向量索引管理
 * - 语义搜索
 * - 文件摘要生成
 * - 图片标签生成
 * - 智能重命名建议
 */

import { Hono } from 'hono';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { getDb, files } from '../db';
import { authMiddleware } from '../middleware/auth';
import { ERROR_CODES, logger } from '@osshelf/shared';
import type { Env, Variables } from '../types/env';
import { z } from 'zod';

interface IndexTask {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}
import {
  indexFileVector,
  deleteFileVector,
  buildFileTextForVector,
  isAIConfigured,
  searchAndFetchFiles,
} from '../lib/vectorIndex';
import {
  generateFileSummary,
  generateImageTags,
  suggestFileName,
  suggestFileNameFromContent,
  canGenerateSummary,
} from '../lib/ai/features';
import { createNotification, sendNotification } from '../lib/notificationUtils';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('/*', authMiddleware);

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(20),
  threshold: z.number().min(0).max(1).default(0.7),
  mimeType: z.string().optional(),
});

app.get('/status', async (c) => {
  const configured = await isAIConfigured(c.env);
  return c.json({
    success: true,
    data: {
      configured,
      features: {
        semanticSearch: configured,
        summary: !!c.env.AI,
        imageTags: !!c.env.AI,
        renameSuggest: !!c.env.AI,
      },
    },
  });
});

// ── 具体路径必须在 :fileId 参数路由之前，否则 Hono 会把 "batch"/"all"/"status" 当 fileId 匹配 ──

app.post('/index/batch', async (c) => {
  const userId = c.get('userId')!;
  const { fileIds } = await c.req.json();

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '请提供文件ID列表' } }, 400);
  }

  const db = getDb(c.env.DB);
  const validFiles = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
    .all();

  const validIds = new Set(validFiles.map((f) => f.id));
  const filteredIds = fileIds.filter((id: string) => validIds.has(id));

  const results = [];
  for (const fileId of filteredIds) {
    try {
      const text = await buildFileTextForVector(c.env, fileId);
      await indexFileVector(c.env, fileId, text);
      results.push({ fileId, status: 'success' });
    } catch (error) {
      results.push({
        fileId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return c.json({ success: true, data: results });
});

app.post('/index/all', async (c) => {
  const userId = c.get('userId')!;

  const taskKey = `ai:index:task:${userId}`;
  const existingTask = await c.env.KV.get(taskKey, 'json');

  if (existingTask && (existingTask as IndexTask).status === 'running') {
    return c.json({
      success: false,
      error: {
        code: ERROR_CODES.CONFLICT,
        message: '已有索引任务正在运行，请等待完成',
      },
    });
  }

  if (existingTask) {
    await c.env.KV.delete(taskKey);
  }

  const task: IndexTask = {
    id: crypto.randomUUID(),
    status: 'running',
    total: 0,
    processed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await c.env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

  c.executionCtx.waitUntil(runBatchIndexTask(c.env, userId, task));

  return c.json({
    success: true,
    data: {
      message: '索引任务已启动，将在后台运行',
      task,
    },
  });
});

app.get('/index/status', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:index:task:${userId}`;

  const task = await c.env.KV.get(taskKey, 'json');

  if (!task) {
    return c.json({
      success: true,
      data: {
        status: 'idle',
        message: '没有正在运行的索引任务',
      },
    });
  }

  return c.json({ success: true, data: task });
});

app.delete('/index/task', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:index:task:${userId}`;

  const existingTask = await c.env.KV.get(taskKey, 'json');

  if (!existingTask) {
    return c.json({
      success: true,
      data: { message: '没有需要取消的任务' },
    });
  }

  const task = existingTask as IndexTask;
  task.status = 'cancelled';
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  task.error = '用户手动取消';

  await c.env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

  return c.json({
    success: true,
    data: { message: '索引任务已取消', task },
  });
});

// 批量处理路由必须在 :fileId 参数路由之前
interface SummarizeTask {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

app.post('/summarize/batch', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:summarize:task:${userId}`;
  const existingTask = await c.env.KV.get(taskKey, 'json');

  if (existingTask && (existingTask as SummarizeTask).status === 'running') {
    return c.json({
      success: false,
      error: {
        code: ERROR_CODES.CONFLICT,
        message: '已有摘要生成任务正在运行，请等待完成',
      },
    });
  }

  if (existingTask) {
    await c.env.KV.delete(taskKey);
  }

  const task: SummarizeTask = {
    id: crypto.randomUUID(),
    status: 'running',
    total: 0,
    processed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await c.env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

  c.executionCtx.waitUntil(runBatchSummarizeTask(c.env, userId, task));

  return c.json({
    success: true,
    data: {
      message: '批量摘要生成任务已启动，将在后台运行',
      task,
    },
  });
});

app.get('/summarize/task', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:summarize:task:${userId}`;

  const task = await c.env.KV.get(taskKey, 'json');

  if (!task) {
    return c.json({
      success: true,
      data: {
        status: 'idle',
        message: '没有正在运行的摘要生成任务',
      },
    });
  }

  return c.json({ success: true, data: task });
});

interface TagsTask {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

app.post('/tags/batch', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:tags:task:${userId}`;
  const existingTask = await c.env.KV.get(taskKey, 'json');

  if (existingTask && (existingTask as TagsTask).status === 'running') {
    return c.json({
      success: false,
      error: {
        code: ERROR_CODES.CONFLICT,
        message: '已有标签生成任务正在运行，请等待完成',
      },
    });
  }

  if (existingTask) {
    await c.env.KV.delete(taskKey);
  }

  const task: TagsTask = {
    id: crypto.randomUUID(),
    status: 'running',
    total: 0,
    processed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await c.env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

  c.executionCtx.waitUntil(runBatchTagsTask(c.env, userId, task));

  return c.json({
    success: true,
    data: {
      message: '批量标签生成任务已启动，将在后台运行',
      task,
    },
  });
});

// 取消摘要任务
app.delete('/summarize/batch', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:summarize:task:${userId}`;
  const existingTask = await c.env.KV.get(taskKey, 'json');

  if (!existingTask) {
    return c.json({ success: true, data: { message: '没有需要取消的任务' } });
  }

  const task = existingTask as SummarizeTask;
  task.status = 'cancelled';
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  task.error = '用户手动取消';

  await c.env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

  return c.json({ success: true, data: { message: '摘要任务已取消', task } });
});

// 取消标签任务
app.delete('/tags/batch', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:tags:task:${userId}`;
  const existingTask = await c.env.KV.get(taskKey, 'json');

  if (!existingTask) {
    return c.json({ success: true, data: { message: '没有需要取消的任务' } });
  }

  const task = existingTask as TagsTask;
  task.status = 'cancelled';
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  task.error = '用户手动取消';

  await c.env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

  return c.json({ success: true, data: { message: '标签任务已取消', task } });
});

app.get('/tags/task', async (c) => {
  const userId = c.get('userId')!;
  const taskKey = `ai:tags:task:${userId}`;

  const task = await c.env.KV.get(taskKey, 'json');

  if (!task) {
    return c.json({
      success: true,
      data: {
        status: 'idle',
        message: '没有正在运行的标签生成任务',
      },
    });
  }

  return c.json({ success: true, data: task });
});

// 具体路径路由必须在 :fileId 参数路由之前
app.get('/index/stats', async (c) => {
  const userId = c.get('userId')!;
  const db = getDb(c.env.DB);

  const allFiles = await db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
    .all();

  const stats = {
    editable: { total: 0, noSummary: 0, notIndexed: 0 },
    image: { total: 0, noTags: 0, notIndexed: 0 },
    other: { total: 0, notIndexed: 0 },
  };

  for (const file of allFiles) {
    const isEditable = canGenerateSummary(file.mimeType, file.name);
    const isImage = file.mimeType?.startsWith('image/') ?? false;

    if (isEditable) {
      stats.editable.total++;
      if (!file.aiSummary) stats.editable.noSummary++;
      if (!file.vectorIndexedAt) stats.editable.notIndexed++;
    } else if (isImage) {
      stats.image.total++;
      if (!file.aiTags) stats.image.noTags++;
      if (!file.vectorIndexedAt) stats.image.notIndexed++;
    } else {
      stats.other.total++;
      if (!file.vectorIndexedAt) stats.other.notIndexed++;
    }
  }

  return c.json({ success: true, data: stats });
});

app.get('/index/vectors', async (c) => {
  const userId = c.get('userId')!;
  const db = getDb(c.env.DB);
  const page = parseInt(c.req.query('page') || '1');
  const pageSize = parseInt(c.req.query('pageSize') || '20');
  const search = c.req.query('search') || '';

  const allFiles = await db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
    .all();

  const indexedFiles = allFiles
    .filter((f) => f.vectorIndexedAt)
    .filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.vectorIndexedAt!).getTime() - new Date(a.vectorIndexedAt!).getTime());

  const total = indexedFiles.length;
  const totalPages = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  const paginatedFiles = indexedFiles.slice(offset, offset + pageSize);

  const vectorsWithMetadata = paginatedFiles.map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    vectorIndexedAt: file.vectorIndexedAt,
    aiSummary: file.aiSummary,
    indexedTextLength: (file.name + (file.aiSummary || '') + (file.description || '')).length,
    indexedTextPreview: file.name + (file.aiSummary ? ` - ${file.aiSummary.slice(0, 100)}...` : ''),
  }));

  return c.json({
    success: true,
    data: {
      vectors: vectorsWithMetadata,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    },
  });
});

app.delete('/index/vectors/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  try {
    if (c.env.VECTORIZE) {
      await c.env.VECTORIZE.deleteByIds([fileId]);
    }

    await db.update(files).set({ vectorIndexedAt: null }).where(eq(files.id, fileId));

    return c.json({ success: true, data: { message: '向量索引已删除' } });
  } catch (error) {
    logger.error('AI', 'Failed to delete vector', { fileId }, error);
    return c.json({ success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: '删除向量索引失败' } }, 500);
  }
});

app.get('/index/diagnose', async (c) => {
  const userId = c.get('userId')!;
  const db = getDb(c.env.DB);

  const diagnoseResult = {
    vectorize: {
      configured: !!c.env.VECTORIZE,
      totalCount: 0,
      userCount: 0,
      sampleVectors: [] as Array<{ id: string; score: number; metadata: Record<string, unknown> }>,
    },
    database: {
      totalFiles: 0,
      indexedFiles: 0,
      filesWithSummary: 0,
    },
    testSearch: {
      success: false,
      resultCount: 0,
      error: '',
    },
  };

  try {
    if (c.env.VECTORIZE) {
      const testVector = new Array(1024).fill(0).map(() => Math.random());
      const allResults = await c.env.VECTORIZE.query(testVector, {
        topK: 100,
        returnMetadata: 'all',
      });
      diagnoseResult.vectorize.totalCount = allResults.matches.length;

      const userResults = await c.env.VECTORIZE.query(testVector, {
        topK: 100,
        filter: { userId } as VectorizeVectorMetadataFilter,
        returnMetadata: 'all',
      });
      diagnoseResult.vectorize.userCount = userResults.matches.length;

      diagnoseResult.vectorize.sampleVectors = userResults.matches.slice(0, 5).map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata as Record<string, unknown>,
      }));
    }
  } catch (error) {
    diagnoseResult.vectorize.userCount = -1;
    logger.error('AI', 'Vectorize diagnose failed', { userId }, error);
  }

  try {
    const allFiles = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
      .all();

    diagnoseResult.database.totalFiles = allFiles.length;
    diagnoseResult.database.indexedFiles = allFiles.filter((f) => f.vectorIndexedAt).length;
    diagnoseResult.database.filesWithSummary = allFiles.filter((f) => f.aiSummary).length;
  } catch (error) {
    logger.error('AI', 'Database diagnose failed', { userId }, error);
  }

  try {
    if (c.env.VECTORIZE && c.env.AI) {
      const testQuery = '测试搜索';
      const result = await (c.env.AI as any).run('@cf/baai/bge-m3', {
        text: [testQuery],
      });

      if (result?.data?.length > 0) {
        const searchResults = await c.env.VECTORIZE.query(result.data[0], {
          topK: 10,
          filter: { userId } as VectorizeVectorMetadataFilter,
          returnMetadata: 'all',
        });

        diagnoseResult.testSearch = {
          success: true,
          resultCount: searchResults.matches.length,
          error: '',
        };
      }
    }
  } catch (error) {
    diagnoseResult.testSearch.error = error instanceof Error ? error.message : String(error);
  }

  return c.json({ success: true, data: diagnoseResult });
});

app.get('/index/sample/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  const result = {
    file: {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      vectorIndexedAt: file.vectorIndexedAt,
      aiSummary: file.aiSummary,
    },
    vectorize: null as {
      found: boolean;
      metadata: Record<string, unknown> | null;
    } | null,
    indexedText: '',
  };

  try {
    if (c.env.VECTORIZE) {
      const testVector = new Array(1024).fill(0).map(() => Math.random());
      const searchResult = await c.env.VECTORIZE.query(testVector, {
        topK: 1000,
        filter: { userId } as VectorizeVectorMetadataFilter,
        returnMetadata: 'all',
      });

      const found = searchResult.matches.find((m) => m.id === fileId);
      result.vectorize = {
        found: !!found,
        metadata: found ? (found.metadata as Record<string, unknown>) : null,
      };
    }
  } catch (error) {
    logger.error('AI', 'Failed to check vectorize', { fileId }, error);
  }

  try {
    const text = await buildFileTextForVector(c.env, fileId);
    result.indexedText = text.slice(0, 500) + (text.length > 500 ? '...' : '');
  } catch (error) {
    logger.error('AI', 'Failed to build text', { fileId }, error);
  }

  return c.json({ success: true, data: result });
});

// :fileId 参数路由放在所有具体路径之后
app.post('/index/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  if (file.isFolder) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '文件夹不支持向量化' } },
      400
    );
  }

  const text = await buildFileTextForVector(c.env, fileId);
  await indexFileVector(c.env, fileId, text);

  return c.json({ success: true, data: { message: '向量化完成' } });
});

app.delete('/index/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  await deleteFileVector(c.env, fileId);

  await db.update(files).set({ vectorIndexedAt: null }).where(eq(files.id, fileId));

  return c.json({ success: true });
});

app.post('/search', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = searchSchema.safeParse(body);

  if (!result.success) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } },
      400
    );
  }

  const { query, limit, threshold, mimeType } = result.data;

  // searchAndFetchFiles 内部用 inArray 单次查询，避免全表扫描
  const items = await searchAndFetchFiles(c.env, query, userId, {
    limit,
    threshold,
    mimeType,
  });

  return c.json({ success: true, data: items });
});

app.post('/summarize/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  try {
    const result = await generateFileSummary(c.env, fileId, undefined, userId);

    sendNotification(c, {
      userId,
      type: 'ai_complete',
      title: 'AI 摘要生成完成',
      body: `文件「${file.name}」的摘要已生成`,
      data: {
        fileId,
        fileName: file.name,
        feature: 'summary',
      },
    });

    return c.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成摘要失败';
    return c.json({ success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message } }, 500);
  }
});

app.post('/tags/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  if (!file.mimeType?.startsWith('image/')) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '仅支持图片文件' } }, 400);
  }

  try {
    const result = await generateImageTags(c.env, fileId, undefined, userId);

    sendNotification(c, {
      userId,
      type: 'ai_complete',
      title: 'AI 标签生成完成',
      body: `图片「${file.name}」的标签已生成`,
      data: {
        fileId,
        fileName: file.name,
        feature: 'tags',
      },
    });

    return c.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成标签失败';
    return c.json({ success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message } }, 500);
  }
});

app.post('/rename-suggest/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  try {
    const result = await suggestFileName(c.env, fileId, undefined, userId);
    return c.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成重命名建议失败';
    return c.json({ success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message } }, 500);
  }
});

const nameSuggestSchema = z.object({
  content: z.string().min(30, '文件内容至少需要30个字符'),
  mimeType: z.string().nullable().optional(),
  extension: z.string().optional(),
});

app.post('/name-suggest', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = nameSuggestSchema.safeParse(body);

  if (!result.success) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } },
      400
    );
  }

  const { content, mimeType, extension } = result.data;

  try {
    const suggestions = await suggestFileNameFromContent(c.env, content, mimeType || null, extension || '', userId);
    return c.json({ success: true, data: suggestions });
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成命名建议失败';
    return c.json({ success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message } }, 500);
  }
});

app.get('/file/:fileId', async (c) => {
  const userId = c.get('userId')!;
  const fileId = c.req.param('fileId');
  const db = getDb(c.env.DB);

  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .get();

  if (!file) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '文件不存在' } }, 404);
  }

  return c.json({
    success: true,
    data: {
      hasSummary: !!file.aiSummary,
      summary: file.aiSummary,
      summaryAt: file.aiSummaryAt,
      hasTags: !!file.aiTags,
      tags: file.aiTags ? JSON.parse(file.aiTags) : [],
      tagsAt: file.aiTagsAt,
      vectorIndexed: !!file.vectorIndexedAt,
      vectorIndexedAt: file.vectorIndexedAt,
    },
  });
});

async function runBatchSummarizeTask(env: Env, userId: string, task: SummarizeTask): Promise<void> {
  const db = getDb(env.DB);
  const taskKey = `ai:summarize:task:${userId}`;
  const concurrency = 2;
  const FILE_TIMEOUT_MS = 30000;
  const MAX_ERRORS = 15;
  const BATCH_DELAY_MS = 1500;
  const RATE_LIMIT_DELAY_MS = 8000;

  const isRateLimitedError = (error: string): boolean => {
    const lowerError = error.toLowerCase();
    return (
      lowerError.includes('rate limit') ||
      lowerError.includes('too many requests') ||
      lowerError.includes('429') ||
      lowerError.includes('throttl') ||
      lowerError.includes('overload')
    );
  };

  try {
    const allFiles = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false), isNull(files.aiSummary)))
      .all();

    const editableFiles = allFiles.filter((f) => canGenerateSummary(f.mimeType, f.name));

    task.total = editableFiles.length;
    task.processed = 0;
    task.failed = 0;
    await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

    const summarizeFileWithRetry = async (
      fileId: string,
      retryCount: number = 0
    ): Promise<{ success: boolean; error?: string }> => {
      const currentTask = await env.KV.get(taskKey, 'json');
      if (currentTask && (currentTask as SummarizeTask).status === 'cancelled') {
        return { success: false, error: '任务已取消' };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

      try {
        await generateFileSummary(env, fileId, undefined, undefined, controller.signal);
        clearTimeout(timeoutId);
        return { success: true };
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          return { success: false, error: '处理超时' };
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (isRateLimitedError(errorMsg) && retryCount < 3) {
          logger.warn('AI', 'Rate limited, waiting before retry', { fileId, retryCount });
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS * (retryCount + 1)));
          return summarizeFileWithRetry(fileId, retryCount + 1);
        }

        return { success: false, error: errorMsg };
      }
    };

    let consecutiveErrors = 0;
    let rateLimitBackoff = false;

    for (let i = 0; i < editableFiles.length; i += concurrency) {
      const currentTask = await env.KV.get(taskKey, 'json');
      if (currentTask && (currentTask as SummarizeTask).status === 'cancelled') {
        task.status = 'cancelled';
        task.error = '用户手动取消';
        break;
      }

      if (rateLimitBackoff || (i > 0 && i % 10 === 0)) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS * 2));
        rateLimitBackoff = false;
      } else if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }

      const batch = editableFiles.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((f) => summarizeFileWithRetry(f.id)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            task.processed = (task.processed || 0) + 1;
            consecutiveErrors = 0;
          } else {
            task.failed = (task.failed || 0) + 1;
            consecutiveErrors++;
            if (isRateLimitedError(result.value.error || '')) {
              rateLimitBackoff = true;
            }
          }
        } else {
          task.failed = (task.failed || 0) + 1;
          consecutiveErrors++;
        }
      }

      if (consecutiveErrors >= MAX_ERRORS) {
        task.status = 'failed';
        task.error = `连续${MAX_ERRORS}次错误，任务终止（可能触发API限流，请稍后重试）`;
        break;
      }

      task.updatedAt = new Date().toISOString();
      await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
    }

    if (task.status !== 'cancelled' && task.status !== 'failed') {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
    }
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
    task.updatedAt = new Date().toISOString();
  }

  await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
}

async function runBatchTagsTask(env: Env, userId: string, task: TagsTask): Promise<void> {
  const db = getDb(env.DB);
  const taskKey = `ai:tags:task:${userId}`;
  const concurrency = 2;
  const FILE_TIMEOUT_MS = 60000;
  const MAX_ERRORS = 15;
  const BATCH_DELAY_MS = 2000;
  const RATE_LIMIT_DELAY_MS = 10000;

  const isRateLimitedError = (error: string): boolean => {
    const lowerError = error.toLowerCase();
    return (
      lowerError.includes('rate limit') ||
      lowerError.includes('too many requests') ||
      lowerError.includes('429') ||
      lowerError.includes('throttl') ||
      lowerError.includes('overload')
    );
  };

  try {
    const allImages = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.userId, userId),
          isNull(files.deletedAt),
          eq(files.isFolder, false),
          isNull(files.aiTags),
          sql`${files.mimeType} LIKE 'image/%'`
        )
      )
      .all();

    task.total = allImages.length;
    task.processed = 0;
    task.failed = 0;
    await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

    const generateTagsWithRetry = async (
      fileId: string,
      retryCount: number = 0
    ): Promise<{ success: boolean; error?: string }> => {
      const currentTask = await env.KV.get(taskKey, 'json');
      if (currentTask && (currentTask as TagsTask).status === 'cancelled') {
        return { success: false, error: '任务已取消' };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

      try {
        await generateImageTags(env, fileId);
        clearTimeout(timeoutId);
        return { success: true };
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          return { success: false, error: '处理超时' };
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (isRateLimitedError(errorMsg) && retryCount < 3) {
          logger.warn('AI', 'Rate limited on tags, waiting before retry', { fileId, retryCount });
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS * (retryCount + 1)));
          return generateTagsWithRetry(fileId, retryCount + 1);
        }

        return { success: false, error: errorMsg };
      }
    };

    let consecutiveErrors = 0;
    let rateLimitBackoff = false;

    for (let i = 0; i < allImages.length; i += concurrency) {
      const currentTask = await env.KV.get(taskKey, 'json');
      if (currentTask && (currentTask as TagsTask).status === 'cancelled') {
        task.status = 'cancelled';
        task.error = '用户手动取消';
        break;
      }

      if (rateLimitBackoff || (i > 0 && i % 6 === 0)) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS * 2));
        rateLimitBackoff = false;
      } else if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }

      const batch = allImages.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((f) => generateTagsWithRetry(f.id)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            task.processed = (task.processed || 0) + 1;
            consecutiveErrors = 0;
          } else {
            task.failed = (task.failed || 0) + 1;
            consecutiveErrors++;
            if (isRateLimitedError(result.value.error || '')) {
              rateLimitBackoff = true;
            }
          }
        } else {
          task.failed = (task.failed || 0) + 1;
          consecutiveErrors++;
        }
      }

      if (consecutiveErrors >= MAX_ERRORS) {
        task.status = 'failed';
        task.error = `连续${MAX_ERRORS}次错误，任务终止（可能触发API限流，请稍后重试）`;
        break;
      }

      task.updatedAt = new Date().toISOString();
      await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
    }

    if (task.status !== 'cancelled' && task.status !== 'failed') {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
    }
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
    task.updatedAt = new Date().toISOString();
  }

  await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
}

async function runBatchIndexTask(env: Env, userId: string, task: IndexTask): Promise<void> {
  const db = getDb(env.DB);
  const taskKey = `ai:index:task:${userId}`;
  const concurrency = 2;
  const FILE_TIMEOUT_MS = 60000;
  const MAX_ERRORS = 15;
  const BATCH_DELAY_MS = 1000;
  const RATE_LIMIT_DELAY_MS = 8000;

  const isRateLimitedError = (error: string): boolean => {
    const lowerError = error.toLowerCase();
    return (
      lowerError.includes('rate limit') ||
      lowerError.includes('too many requests') ||
      lowerError.includes('429') ||
      lowerError.includes('throttl') ||
      lowerError.includes('overload')
    );
  };

  try {
    const allUnindexed = await db
      .select({ id: files.id })
      .from(files)
      .where(
        and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false), isNull(files.vectorIndexedAt))
      )
      .all();

    task.total = allUnindexed.length;
    task.processed = 0;
    task.failed = 0;
    await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });

    const indexFileWithRetry = async (
      fileId: string,
      retryCount: number = 0
    ): Promise<{ success: boolean; error?: string }> => {
      const currentTask = await env.KV.get(taskKey, 'json');
      if (currentTask && (currentTask as IndexTask).status === 'cancelled') {
        return { success: false, error: '任务已取消' };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

      try {
        const text = await buildFileTextForVector(env, fileId);
        if (!text || text.trim().length === 0) {
          clearTimeout(timeoutId);
          return { success: false, error: '文件内容为空' };
        }
        await indexFileVector(env, fileId, text);
        clearTimeout(timeoutId);
        return { success: true };
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          return { success: false, error: '处理超时' };
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (isRateLimitedError(errorMsg) && retryCount < 3) {
          logger.warn('AI', 'Rate limited on index, waiting before retry', { fileId, retryCount });
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS * (retryCount + 1)));
          return indexFileWithRetry(fileId, retryCount + 1);
        }

        return { success: false, error: errorMsg };
      }
    };

    let consecutiveErrors = 0;
    let rateLimitBackoff = false;

    for (let i = 0; i < allUnindexed.length; i += concurrency) {
      const currentTask = await env.KV.get(taskKey, 'json');
      if (currentTask && (currentTask as IndexTask).status === 'cancelled') {
        task.status = 'cancelled';
        task.error = '用户手动取消';
        break;
      }

      if (rateLimitBackoff || (i > 0 && i % 15 === 0)) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS * 3));
        rateLimitBackoff = false;
      } else if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }

      const batch = allUnindexed.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((f) => indexFileWithRetry(f.id)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            task.processed = (task.processed || 0) + 1;
            consecutiveErrors = 0;
          } else {
            task.failed = (task.failed || 0) + 1;
            consecutiveErrors++;
            if (isRateLimitedError(result.value.error || '')) {
              rateLimitBackoff = true;
            }
          }
        } else {
          task.failed = (task.failed || 0) + 1;
          consecutiveErrors++;
        }
      }

      if (consecutiveErrors >= MAX_ERRORS) {
        task.status = 'failed';
        task.error = `连续${MAX_ERRORS}次错误，任务终止（可能触发API限流，请稍后重试）`;
        break;
      }

      task.updatedAt = new Date().toISOString();
      await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
    }

    if (task.status !== 'cancelled' && task.status !== 'failed') {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
    }
  } catch (error) {
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
    task.updatedAt = new Date().toISOString();
  }

  await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
}

const chatSchema = z.object({
  query: z.string().min(1).max(500),
  scope: z.enum(['all', 'folder']).default('all'),
  folderId: z.string().optional(),
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
    return c.json({ success: false, error: { code: 'AI_NOT_CONFIGURED', message: 'AI 功能未配置' } }, 503);
  }

  const { query, limit } = result.data;

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

  const context = similar
    .map((f, i) => {
      const parts = [`[${i + 1}] 文件名：${f.name}`];
      if (f.aiSummary) parts.push(`摘要：${f.aiSummary}`);
      if (f.description) parts.push(`描述：${f.description}`);
      return parts.join('\n');
    })
    .join('\n\n');

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

export default app;
