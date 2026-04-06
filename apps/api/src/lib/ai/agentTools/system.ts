/**
 * system.ts — 系统信息与帮助工具
 *
 * 功能:
 * - 系统状态检查
 * - 功能说明与使用指南
 * - 版本信息
 * - 常见问题解答
 */

import { eq, and, isNull, desc, sql, like, or } from 'drizzle-orm';
import { getDb, files, apiKeys, webhooks, auditLogs } from '../../../db';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition } from './types';
import { formatBytes } from '../utils';

export const definitions: ToolDefinition[] = [
  // 1. get_system_status — 系统状态
  {
    type: 'function',
    function: {
      name: 'get_system_status',
      description: `【系统状态】查看系统运行状态和健康情况。
适用场景：
• "系统正常吗"
• "服务状态如何"
• "有什么问题吗"

显示：存储连接、数据库状态、AI服务等`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // 2. get_help — 使用帮助
  {
    type: 'function',
    function: {
      name: 'get_help',
      description: `【使用指南】获取功能说明和操作指引。
适用场景：
• "这个怎么用"
• "有哪些功能"
• "帮我看看教程"

提供：功能列表、最佳实践、常见操作示例`,
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '具体主题（可选，如"搜索"、"分享"、"上传"）' },
        },
      },
    },
  },

  // 3. get_version_info — 版本信息
  {
    type: 'function',
    function: {
      name: 'get_version_info',
      description: `【版本信息】查看当前系统的版本号和更新日志。
适用场景：
• "这是什么版本"
• "最近更新了什么"
• "有新功能吗"`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // 4. get_faq — 常见问题
  {
    type: 'function',
    function: {
      name: 'get_faq',
      description: `【常见问题】查看FAQ和解决方案。
适用场景：
• "遇到问题了怎么办"
• "为什么XX不行"
• "报错怎么解决"

涵盖：上传失败、搜索无结果、权限问题等常见场景`,
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '问题分类（可选）' },
        },
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
