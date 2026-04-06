/**
 * system.ts — 系统管理工具
 *
 * 功能:
 * - 获取用户信息
 * - API密钥管理
 * - Webhook管理
 * - 审计日志查询
 */

import { eq, and, isNull, desc, sql, like, or, inArray } from 'drizzle-orm';
import { getDb, files, apiKeys, webhooks, auditLogs } from '../../../db';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition } from './types';
import { formatBytes } from '../utils';

export const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description: `【获取用户信息】查看当前用户的账户信息和配置。
包括存储使用情况、角色、设置等。`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_api_keys',
      description: `【列出API密钥】列出当前用户的所有API密钥。
显示创建时间、最后使用时间、状态等。
⚠️ 不会返回完整的密钥值，只显示前8位和后4位。`,
      parameters: {
        type: 'object',
        properties: {
          includeExpired: { type: 'boolean', description: '是否包含已过期的密钥，默认 false' },
          limit: { type: 'number', description: '返回数量，默认 20' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_api_key',
      description: `【创建API密钥】生成新的API密钥用于程序化访问。
可设置名称、权限范围、过期时间等。
⚠️ 创建后请立即保存密钥，之后无法再次查看完整值。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '密钥名称（便于识别）' },
          scopes: { type: 'array', items: { type: 'string' }, description: '权限范围，如 ["read", "write", "admin"]' },
          expiresInDays: { type: 'number', description: '有效天数，不传则永不过期' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revoke_api_key',
      description: `【撤销API密钥】立即作废指定的API密钥。
撤销后将无法再使用此密钥进行API调用。
适用场景："这个密钥泄露了需要作废"、"不再需要某个密钥"`,
      parameters: {
        type: 'object',
        properties: {
          keyId: { type: 'string', description: 'API 密钥 ID' },
          reason: { type: 'string', description: '撤销原因（用于审计）' },
          _confirmed: { type: 'boolean', description: '用户确认（必须为true）' },
        },
        required: ['keyId', '_confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_webhooks',
      description: `【列出Webhook】列出所有已配置的Webhook端点。
显示触发事件类型、URL、状态等。`,
      parameters: {
        type: 'object',
        properties: {
          includeDisabled: { type: 'boolean', description: '是否包含已禁用的Webhook，默认 false' },
          limit: { type: 'number', description: '返回数量，默认 20' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_webhook',
      description: `【创建Webhook】配置新的Webhook端点接收系统事件通知。
支持多种事件类型：文件上传/删除/分享等。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Webhook 名称' },
          url: { type: 'string', description: '回调 URL' },
          events: {
            type: 'array',
            items: { type: 'string' },
            description: '要监听的事件类型，如 ["file.uploaded", "file.deleted", "share.created"]',
          },
          secret: { type: 'string', description: '签名密钥（可选，用于验证回调）' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['name', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_audit_logs',
      description: `【审计日志】查询用户的操作审计日志。
记录所有重要操作：上传、删除、分享、权限变更等。
适合排查问题或了解操作历史。`,
      parameters: {
        type: 'object',
        properties: {
          actionType: { type: 'string', description: '按操作类型筛选（可选）' },
          limit: { type: 'number', description: '返回数量，默认 30' },
          sinceHours: { type: 'number', description: '最近N小时，默认 24' },
        },
        required: [],
      },
    },
  },
];

export class SystemTools {

  static async executeGetUserProfile(env: Env, userId: string, _args: Record<string, unknown>) {
    const db = getDb(env.DB);

    const [stats, starredCount] = await Promise.all([
      db
        .select({
          totalSize: (sql as any)`COALESCE(SUM(${files.size}), 0)`.mapWith(Number),
          fileCount: (sql as any)`COUNT(*)`.mapWith(Number),
          folderCount: (sql as any)`COUNT(*) FILTER (WHERE ${files.isFolder} = TRUE)`.mapWith(Number),
        })
        .from(files)
        .where(and(eq(files.userId, userId), isNull(files.deletedAt)))
        .get(),
      db
        .select({ cnt: (sql as any)`COUNT(*)`.mapWith(Number) })
        .from(files)
        .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isStarred, true)))
        .get(),
    ]);

    return {
      userId,
      storage: {
        usedBytes: stats?.totalSize || 0,
        usedFormatted: formatBytes(stats?.totalSize || 0),
      },
      files: {
        total: stats?.fileCount || 0,
        folders: stats?.folderCount || 0,
        starred: starredCount?.cnt || 0,
      },
      features: {
        aiEnabled: true,
        vectorSearchEnabled: true,
        sharingEnabled: true,
        webhooksEnabled: true,
      },
    };
  }

  static async executeListApiKeys(env: Env, userId: string, args: Record<string, unknown>) {
    const includeExpired = args.includeExpired === true;
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(env.DB);

    try {
      const conditions: any[] = [eq(apiKeys.userId, userId)];
      if (!includeExpired) {
        conditions.push(or(isNull(apiKeys.expiresAt), (sql as any)`${apiKeys.expiresAt} > NOW()`));
      }

      const keys = await db.select()
        .from(apiKeys)
        .where(and(...conditions))
        .orderBy(desc(apiKeys.createdAt))
        .limit(limit)
        .all();

      return {
        total: keys.length,
        keys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix,
          scopes: k.scopes ? JSON.parse(k.scopes as string) : [],
          lastUsedAt: k.lastUsedAt,
          expiresAt: k.expiresAt,
          isActive: k.isActive !== false,
          createdAt: k.createdAt,
        })),
      };
    } catch (error) {
      return { total: 0, keys: [], note: 'API密钥功能可能未启用' };
    }
  }

  static async executeCreateApiKey(env: Env, userId: string, args: Record<string, unknown>) {
    const name = args.name as string;
    const scopes = (args.scopes as string[]) || ['read'];
    const expiresInDays = args.expiresInDays as number | undefined;
    const db = getDb(env.DB);

    const rawKey = `oss_${crypto.randomUUID().replace(/-/g, '')}`;
    const keyPrefix = `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`;
    const hashedKey = await hashApiKey(rawKey);
    const now = new Date().toISOString();

    const keyId = crypto.randomUUID();
    await db.insert(apiKeys).values({
      id: keyId,
      userId,
      name,
      keyHash: hashedKey,
      keyPrefix,
      scopes: JSON.stringify(scopes),
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null,
      isActive: true,
      createdAt: now,
    });

    logger.info('AgentTool', 'Created API key via agent tool', { keyId, name, scopes });

    return {
      success: true,
      message: 'API密钥已创建（请立即保存，之后无法查看完整值）',
      keyId,
      name,
      key: rawKey,
      scopes,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null,
      warning: '⚠️ 请妥善保管此密钥，页面刷新后无法再次查看完整值',
    };
  }

  static async executeRevokeApiKey(env: Env, userId: string, args: Record<string, unknown>) {
    const keyId = args.keyId as string;
    const reason = args.reason as string | undefined;
    const db = getDb(env.DB);

    await db.delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .run();

    logger.info('AgentTool', 'Revoked API key', { keyId, reason: reason || '(none)' });

    return {
      success: true,
      message: 'API密钥已撤销',
      keyId,
      revokedAt: new Date().toISOString(),
    };
  }

  static async executeListWebhooks(env: Env, userId: string, args: Record<string, unknown>) {
    const includeDisabled = args.includeDisabled === true;
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(env.DB);

    try {
      const conditions: any[] = [eq(webhooks.userId, userId)];
      if (!includeDisabled) {
        conditions.push(eq(webhooks.isActive, true));
      }

      const hooks = await db.select()
        .from(webhooks)
        .where(and(...conditions))
        .orderBy(desc(webhooks.createdAt))
        .limit(limit)
        .all();

      return {
        total: hooks.length,
        webhooks: (hooks || []).map((h) => ({
          id: h.id,
          url: maskUrl(h.url),
          events: h.events ? JSON.parse(h.events as string) : [],
          isActive: h.isActive,
          lastStatus: h.lastStatus,
          createdAt: h.createdAt,
        })),
      };
    } catch (error) {
      return { total: 0, webhooks: [], note: 'Webhook功能可能未启用' };
    }
  }

  static async executeCreateWebhook(env: Env, userId: string, args: Record<string, unknown>) {
    const url = args.url as string;
    const events = (args.events as string[]) || [];
    const secret = (args.secret as string) || crypto.randomUUID();
    const db = getDb(env.DB);

    const webhookId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(webhooks).values({
      id: webhookId,
      userId,
      url,
      secret,
      events: JSON.stringify(events),
      isActive: true,
      createdAt: now,
    });

    logger.info('AgentTool', 'Created webhook via agent tool', { webhookId, url, eventCount: events.length });

    return {
      success: true,
      message: 'Webhook已创建',
      webhookId,
      url: maskUrl(url),
      events,
      hasSecret: !!secret,
    };
  }

  static async executeGetAuditLogs(env: Env, userId: string, args: Record<string, unknown>) {
    const actionType = args.actionType as string | undefined;
    const limit = Math.min((args.limit as number) || 30, 100);
    const sinceHours = Math.min((args.sinceHours as number) || 24, 168); // 最大7天
    const db = getDb(env.DB);

    const sinceDate = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

    try {
      const conditions: any[] = [
        eq(auditLogs.userId, userId),
        (sql as any)`${auditLogs.createdAt} >= ${sinceDate}`,
      ];
      if (actionType) {
        conditions.push(like(auditLogs.action, `%${actionType}%`));
      }

      const logs = await db.select()
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .all();

      return {
        total: logs.length,
        range: { sinceHours, since: sinceDate },
        logs: (logs || []).map((l) => ({
          id: l.id,
          action: l.action,
          resourceType: l.resourceType,
          resourceId: l.resourceId,
          details: l.details ? JSON.parse(l.details as string) : null,
          status: l.status || 'success',
          errorMessage: l.errorMessage || null,
          ipAddress: l.ipAddress ? maskIp(l.ipAddress) : null,
          userAgent: l.userAgent ? maskUserAgent(l.userAgent) : null,
          createdAt: l.createdAt,
        })),
      };
    } catch (error) {
      return { total: 0, logs: [], range: { sinceHours }, note: '审计日志功能可能未启用' };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

function maskIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return parts[0] + '.' + parts[1] + '.***.***';
  return ip.replace(/\d{1,3}$/, '***');
}

function maskUserAgent(ua: string): string {
  if (ua.length <= 80) return ua;
  return ua.slice(0, 80) + '...';
}
