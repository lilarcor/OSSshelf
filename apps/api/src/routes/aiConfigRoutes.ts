/**
 * aiConfigRoutes.ts
 * AI 配置管理路由
 *
 * 功能:
 * - 模型配置 CRUD
 * - API密钥加密存储
 * - 模型激活/切换
 * - 使用统计查询
 */

import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { getDb, aiModels, aiUsageStats } from '../db';
import { authMiddleware } from '../middleware/auth';
import { ERROR_CODES } from '@osshelf/shared';
import type { Env, Variables } from '../types/env';
import { z } from 'zod';
import { ModelGateway, WorkersAiAdapter, OpenAiCompatibleAdapter } from '../lib/ai';
import { logger } from '@osshelf/shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('/*', authMiddleware);

const createModelSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum(['workers_ai', 'openai_compatible']),
  modelId: z.string().min(1),
  apiEndpoint: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  capabilities: z.array(z.enum(['chat', 'completion', 'embedding', 'vision', 'function_calling'])).default(['chat']),
  maxTokens: z.number().int().min(1).max(128000).default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  systemPrompt: z.string().max(2000).optional(),
  isActive: z.boolean().default(false),
});

const updateModelSchema = createModelSchema.partial();

app.get('/models', async (c) => {
  const userId = c.get('userId')!;
  const gateway = new ModelGateway(c.env);
  const models = await gateway.getAllModels(userId);

  const modelsWithDecryptedKey = models.map((m) => ({
    ...m,
    apiKeyEncrypted: m.apiKeyEncrypted ? '***' : undefined,
    hasApiKey: !!m.apiKeyEncrypted,
  }));

  return c.json({
    success: true,
    data: modelsWithDecryptedKey,
  });
});

app.get('/models/:modelId', async (c) => {
  const userId = c.get('userId')!;
  const modelId = c.req.param('modelId');
  const gateway = new ModelGateway(c.env);

  const model = await gateway.getModelById(modelId, userId);

  if (!model) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '模型不存在' } }, 404);
  }

  return c.json({
    success: true,
    data: {
      ...model,
      apiKeyEncrypted: model.apiKeyEncrypted ? '***' : undefined,
      hasApiKey: !!model.apiKeyEncrypted,
    },
  });
});

app.post('/models', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = createModelSchema.safeParse(body);

  if (!result.success) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } },
      400
    );
  }

  const data = result.data;

  try {
    const db = getDb(c.env.DB);

    if (data.isActive) {
      await db.update(aiModels).set({ isActive: 0 }).where(eq(aiModels.userId, userId));
    }

    const apiKeyEncrypted = data.apiKey ? await encryptApiKey(data.apiKey) : null;

    const newModel = {
      id: crypto.randomUUID(),
      userId,
      name: data.name,
      provider: data.provider,
      modelId: data.modelId,
      apiEndpoint: data.apiEndpoint || null,
      apiKeyEncrypted,
      isActive: data.isActive ? 1 : 0,
      capabilities: JSON.stringify(data.capabilities),
      maxTokens: data.maxTokens,
      temperature: data.temperature,
      systemPrompt: data.systemPrompt || null,
      configJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await db.insert(aiModels).values(newModel);

    logger.info('AI', 'Model created', { userId, modelName: data.name, provider: data.provider });

    return c.json({
      success: true,
      data: {
        id: newModel.id,
        ...data,
        apiKeyEncrypted: undefined,
        hasApiKey: !!apiKeyEncrypted,
      },
    });
  } catch (error) {
    logger.error('AI', 'Failed to create model', { userId }, error);
    return c.json(
      { success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: '创建模型失败' } },
      500
    );
  }
});

app.put('/models/:modelId', async (c) => {
  const userId = c.get('userId')!;
  const modelId = c.req.param('modelId');
  const body = await c.req.json();
  const result = updateModelSchema.safeParse(body);

  if (!result.success) {
    return c.json(
      { success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } },
      400
    );
  }

  const data = result.data;
  const db = getDb(c.env.DB);

  const existingModel = await db
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.id, modelId), eq(aiModels.userId, userId)))
    .get();

  if (!existingModel) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '模型不存在' } }, 404);
  }

  try {
    if (data.isActive) {
      await db.update(aiModels).set({ isActive: 0 }).where(eq(aiModels.userId, userId));
    }

    let apiKeyEncrypted = existingModel.api_key_encrypted;
    if (data.apiKey !== undefined) {
      apiKeyEncrypted = data.apiKey ? await encryptApiKey(data.apiKey) : null;
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.provider !== undefined) updateData.provider = data.provider;
    if (data.modelId !== undefined) updateData.model_id = data.modelId;
    if (data.apiEndpoint !== undefined) updateData.api_endpoint = data.apiEndpoint || null;
    if (data.apiKey !== undefined) updateData.api_key_encrypted = apiKeyEncrypted;
    if (data.isActive !== undefined) updateData.is_active = data.isActive ? 1 : 0;
    if (data.capabilities !== undefined) updateData.capabilities = JSON.stringify(data.capabilities);
    if (data.maxTokens !== undefined) updateData.max_tokens = data.maxTokens;
    if (data.temperature !== undefined) updateData.temperature = data.temperature;
    if (data.systemPrompt !== undefined) updateData.system_prompt = data.systemPrompt || null;

    await db.update(aiModels).set(updateData).where(eq(aiModels.id, modelId));

    logger.info('AI', 'Model updated', { userId, modelId });

    return c.json({ success: true, data: { id: modelId, ...data, apiKeyEncrypted: undefined } });
  } catch (error) {
    logger.error('AI', 'Failed to update model', { userId, modelId }, error);
    return c.json(
      { success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: '更新模型失败' } },
      500
    );
  }
});

app.delete('/models/:modelId', async (c) => {
  const userId = c.get('userId')!;
  const modelId = c.req.param('modelId');
  const db = getDb(c.env.DB);

  const existingModel = await db
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.id, modelId), eq(aiModels.userId, userId)))
    .get();

  if (!existingModel) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '模型不存在' } }, 404);
  }

  try {
    await db.delete(aiModels).where(eq(aiModels.id, modelId));

    logger.info('AI', 'Model deleted', { userId, modelId });

    return c.json({ success: true, data: { message: '模型已删除' } });
  } catch (error) {
    logger.error('AI', 'Failed to delete model', { userId, modelId }, error);
    return c.json(
      { success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: '删除模型失败' } },
      500
    );
  }
});

app.post('/models/:modelId/activate', async (c) => {
  const userId = c.get('userId')!;
  const modelId = c.req.param('modelId');
  const db = getDb(c.env.DB);

  const modelToActivate = await db
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.id, modelId), eq(aiModels.userId, userId)))
    .get();

  if (!modelToActivate) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '模型不存在' } }, 404);
  }

  try {
    await db.update(aiModels).set({ isActive: 0 }).where(eq(aiModels.userId, userId));
    await db.update(aiModels).set({ isActive: 1, updatedAt: new Date().toISOString() }).where(eq(aiModels.id, modelId));

    logger.info('AI', 'Model activated', { userId, modelId });

    return c.json({ success: true, data: { message: '模型已激活', activeModelId: modelId } });
  } catch (error) {
    logger.error('AI', 'Failed to activate model', { userId, modelId }, error);
    return c.json(
      { success: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: '激活模型失败' } },
      500
    );
  }
});

app.get('/providers', (_c) => {
  return c => {
    return c.json({
      success: true,
      data: {
        providers: ModelGateway.getAvailableProviders(),
        workersAiModels: WorkersAiAdapter.getAvailableModels(),
        openAiModels: OpenAiCompatibleAdapter.getPopularModels(),
      },
    });
  };
});

app.get('/status', async (c) => {
  const userId = c.get('userId')!;
  const gateway = new ModelGateway(c.env);

  const activeModel = await gateway.getActiveModel(userId);
  const allModels = await gateway.getAllModels(userId);
  const isWorkersAiConfigured = !!(c.env.AI && c.env.VECTORIZE);

  return c.json({
    success: true,
    data: {
      configured: allModels.length > 0 || isWorkersAiConfigured,
      activeModel: activeModel
        ? {
            id: activeModel.id,
            name: activeModel.name,
            provider: activeModel.provider,
            modelId: activeModel.modelId,
          }
        : null,
      totalModels: allModels.length,
      features: {
        workersAi: isWorkersAiConfigured,
        customApi: allModels.some((m) => m.provider === 'openai_compatible'),
        chat: true,
        embedding: isWorkersAiConfigured,
      },
    },
  });
});

async function encryptApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default app;
