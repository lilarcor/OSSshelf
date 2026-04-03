/**
 * aiTaskQueue.ts
 * AI 批处理任务队列处理器
 *
 * 功能:
 * - 处理单个文件的 AI 任务（索引、摘要、标签）
 * - 更新任务进度
 * - 错误处理和重试
 *
 * 优势:
 * - 每个 Worker 只处理单个文件，避免 CPU 时间限制
 * - 自动重试机制
 * - 任务进度持久化
 */

import type { Env, AiTaskMessage } from '../types/env';
import { getDb, files } from '../db';
import { eq, and, isNull } from 'drizzle-orm';
import { logger } from '@osshelf/shared';
import { indexFileVector, buildFileTextForVector } from './vectorIndex';
import { generateFileSummary, generateImageTags } from './ai/features';

interface TaskProgress {
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

function getTaskKey(type: string, userId: string): string {
  return `ai:${type}:task:${userId}`;
}

async function updateTaskProgress(
  env: Env,
  type: string,
  userId: string,
  updates: Partial<TaskProgress>
): Promise<TaskProgress | null> {
  const taskKey = getTaskKey(type, userId);
  const existing = await env.KV.get(taskKey, 'json');

  if (!existing) {
    return null;
  }

  const task = existing as TaskProgress;
  const updated = {
    ...task,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await env.KV.put(taskKey, JSON.stringify(updated), { expirationTtl: 86400 });
  return updated;
}

async function handleIndexTask(env: Env, message: AiTaskMessage): Promise<{ success: boolean; error?: string }> {
  const { fileId, userId, taskId } = message;

  try {
    const text = await buildFileTextForVector(env, fileId);
    if (!text || text.trim().length === 0) {
      return { success: false, error: '文件内容为空' };
    }

    await indexFileVector(env, fileId, text);

    await updateTaskProgress(env, 'index', userId, {
      processed: await incrementProcessed(env, 'index', userId),
    });

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('AI_QUEUE', 'Index task failed', { fileId, taskId }, error);

    await updateTaskProgress(env, 'index', userId, {
      failed: await incrementFailed(env, 'index', userId),
    });

    return { success: false, error: errorMsg };
  }
}

async function handleSummaryTask(env: Env, message: AiTaskMessage): Promise<{ success: boolean; error?: string }> {
  const { fileId, userId, taskId } = message;

  try {
    await generateFileSummary(env, fileId, undefined, userId);

    await updateTaskProgress(env, 'summarize', userId, {
      processed: await incrementProcessed(env, 'summarize', userId),
    });

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('AI_QUEUE', 'Summary task failed', { fileId, taskId }, error);

    await updateTaskProgress(env, 'summarize', userId, {
      failed: await incrementFailed(env, 'summarize', userId),
    });

    return { success: false, error: errorMsg };
  }
}

async function handleTagsTask(env: Env, message: AiTaskMessage): Promise<{ success: boolean; error?: string }> {
  const { fileId, userId, taskId } = message;

  try {
    await generateImageTags(env, fileId, undefined, userId);

    await updateTaskProgress(env, 'tags', userId, {
      processed: await incrementProcessed(env, 'tags', userId),
    });

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('AI_QUEUE', 'Tags task failed', { fileId, taskId }, error);

    await updateTaskProgress(env, 'tags', userId, {
      failed: await incrementFailed(env, 'tags', userId),
    });

    return { success: false, error: errorMsg };
  }
}

async function incrementProcessed(env: Env, type: string, userId: string): Promise<number> {
  const taskKey = getTaskKey(type, userId);
  const existing = await env.KV.get(taskKey, 'json');
  if (!existing) return 0;
  return (existing as TaskProgress).processed + 1;
}

async function incrementFailed(env: Env, type: string, userId: string): Promise<number> {
  const taskKey = getTaskKey(type, userId);
  const existing = await env.KV.get(taskKey, 'json');
  if (!existing) return 0;
  return (existing as TaskProgress).failed + 1;
}

export async function processAiTaskMessage(
  message: AiTaskMessage,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const { type, fileId, userId, taskId } = message;

  logger.info('AI_QUEUE', 'Processing task', { type, fileId, taskId });

  const taskKey = getTaskKey(type === 'summary' ? 'summarize' : type, userId);
  const task = await env.KV.get(taskKey, 'json');

  if (!task) {
    logger.warn('AI_QUEUE', 'Task not found, skipping', { type, taskId });
    return { success: false, error: '任务不存在' };
  }

  if ((task as TaskProgress).status === 'cancelled') {
    logger.info('AI_QUEUE', 'Task cancelled, skipping', { type, taskId });
    return { success: false, error: '任务已取消' };
  }

  switch (type) {
    case 'index':
      return handleIndexTask(env, message);
    case 'summary':
      return handleSummaryTask(env, message);
    case 'tags':
      return handleTagsTask(env, message);
    default:
      return { success: false, error: `未知任务类型: ${type}` };
  }
}

export async function enqueueAiTasks(
  env: Env,
  type: 'index' | 'summary' | 'tags',
  fileIds: string[],
  userId: string,
  taskId: string
): Promise<void> {
  if (!env.AI_TASKS_QUEUE) {
    throw new Error('AI 任务队列未配置');
  }

  const messages = fileIds.map((fileId) => ({
    body: {
      type,
      fileId,
      userId,
      taskId,
    } as AiTaskMessage,
  }));

  await env.AI_TASKS_QUEUE.sendBatch(messages);
  logger.info('AI_QUEUE', 'Enqueued tasks', { type, count: messages.length, taskId });
}

export async function createTaskRecord(
  env: Env,
  type: 'index' | 'summary' | 'tags',
  userId: string,
  total: number
): Promise<TaskProgress> {
  const taskKey = getTaskKey(type === 'summary' ? 'summarize' : type, userId);
  const task: TaskProgress = {
    id: crypto.randomUUID(),
    status: 'running',
    total,
    processed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await env.KV.put(taskKey, JSON.stringify(task), { expirationTtl: 86400 });
  return task;
}

export async function checkAndCompleteTask(
  env: Env,
  type: 'index' | 'summary' | 'tags',
  userId: string
): Promise<boolean> {
  const taskKey = getTaskKey(type === 'summary' ? 'summarize' : type, userId);
  const task = await env.KV.get(taskKey, 'json');

  if (!task) return false;

  const t = task as TaskProgress;
  const total = t.processed + t.failed;

  if (total >= t.total) {
    await updateTaskProgress(env, type === 'summary' ? 'summarize' : type, userId, {
      status: t.failed > 0 ? 'completed' : 'completed',
      completedAt: new Date().toISOString(),
    });
    logger.info('AI_QUEUE', 'Task completed', { type, userId, processed: t.processed, failed: t.failed });
    return true;
  }

  return false;
}
