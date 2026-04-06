/**
 * share.ts — ⭐ 分享与链接管理工具（增强版）
 *
 * 功能:
 * - 创建分享链接
 * - 列出分享链接
 * - 更新分享设置（新增）
 * - 撤销分享链接（新增）
 * - 分享详情统计（新增）
 * - 创建直链（新增）
 * - 列出/撤销直链（新增）
 * - 创建上传链接（新增）
 */

import { eq, and, isNull, isNotNull, gte, desc, sql, or } from 'drizzle-orm';
import { getDb, files, shares } from '../../../db';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition } from './types';
import { WRITE_TOOLS } from './types';

export const definitions: ToolDefinition[] = [
  // A. 分享链接
  {
    type: 'function',
    function: {
      name: 'create_share',
      description: `【创建分享链接】为文件创建分享链接。
可设置密码、有效期、下载次数限制等。
⚠️ 创建前应先确认文件存在（通过搜索/过滤获取 fileId）。`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          password: { type: 'string', description: '访问密码（可选）' },
          expiresAt: { type: 'string', description: '过期时间（ISO 8601，可选）' },
          maxVisits: { type: 'number', description: '最大访问次数（可选）' },
          allowDownload: { type: 'boolean', description: '是否允许下载，默认 true' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_shares',
      description: `【列出分享链接】列出当前用户的所有活跃分享链接。
支持按状态筛选（全部/仅活跃/仅过期）。`,
      parameters: {
        type: 'object',
        properties: {
          includeExpired: { type: 'boolean', description: '是否包含已过期的分享，默认 false' },
          fileId: { type: 'string', description: '限定某个文件的分享（可选）' },
          limit: { type: 'number', description: '返回数量，默认 20' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_share',
      description: `【更新分享设置】修改已存在的分享链接配置。
适用场景："把这个分享有效期改成7天"、"修改密码"、"取消下载权限"`,
      parameters: {
        type: 'object',
        properties: {
          shareId: { type: 'string', description: '分享链接 ID' },
          password: { type: 'string', description: '新密码（留空则不修改）' },
          expiresAt: { type: 'string', description: '新过期时间（留空则不修改）' },
          maxVisits: { type: 'number', description: '新最大访问次数（留空则不修改）' },
          allowDownload: { type: 'boolean', description: '是否允许下载（留空则不修改）' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['shareId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revoke_share',
      description: `【撤销分享链接】立即作废分享链接。
撤销后将无法再通过此链接访问文件。
适用场景："取消这个分享"、"链接泄露了需要作废"`,
      parameters: {
        type: 'object',
        properties: {
          shareId: { type: 'string', description: '分享链接 ID' },
          reason: { type: 'string', description: '撤销原因（用于审计）' },
          _confirmed: { type: 'boolean', description: '用户确认（必须为true）' },
        },
        required: ['shareId', '_confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_share_details',
      description: `【分享详情】查看分享链接的详细信息和访问统计。
包括创建时间、访问次数、最后访问时间、是否过期等。`,
      parameters: {
        type: 'object',
        properties: {
          shareId: { type: 'string', description: '分享链接 ID' },
        },
        required: ['shareId'],
      },
    },
  },

  // B. 直链管理（2个新工具）🔥
  {
    type: 'function',
    function: {
      name: 'create_direct_link',
      description: `【创建直链】生成文件的直接下载链接（无需登录）。
与分享链接的区别：
- 分享链接: 需登录或有密码，可在页面预览
- 直链: 匿名可直接下载，适合嵌入邮件/IM/文档

适用场景："生成PDF的直链发微信群"、"嵌入文档中的下载链接"`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          expiresInHours: { type: 'number', description: '有效时长（小时），默认 168（7天）' },
          maxDownloads: { type: 'number', description: '最大下载次数（可选）' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revoke_direct_link',
      description: `【撤销直链】立即作废直链。
适用场景："直链被滥用需要紧急停止"、"不再需要公开下载"`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          _confirmed: { type: 'boolean', description: '用户确认（必须为true）' },
        },
        required: ['fileId', '_confirmed'],
      },
    },
  },

  // C. 上传链接（1个新工具）🔥
  {
    type: 'function',
    function: {
      name: 'create_upload_link_for_folder',
      description: `【创建上传链接】为文件夹创建上传链接，允许他人向该文件夹上传文件。
适用场景："给设计团队创建上传链接"、"收集作业/文档"`,
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '目标文件夹 ID' },
          password: { type: 'string', description: '访问密码（可选，建议设置）' },
          expiresInHours: { type: 'number', description: '有效时长（小时），默认 72（3天）' },
          allowedMimeTypes: { type: 'array', items: { type: 'string' }, description: '允许上传的文件类型（如 ["image/*","application/pdf"]），不传则不限' },
          maxSizeBytes: { type: 'number', description: '单个文件大小限制（字节），如 10485760=10MB' },
          maxUploads: { type: 'number', description: '最大上传数量（可选）' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['folderId'],
      },
    },
  },
];

export class ShareTools {

  static async executeCreateShare(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const password = args.password as string | undefined;
    const expiresAtStr = args.expiresAt as string | undefined;
    const maxVisits = args.maxVisits as number | undefined;
    const allowDownload = args.allowDownload !== false;
    const db = getDb(env.DB);

    const file = await db.select().from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();
    if (!file) return { error: `文件不存在或无权访问: ${fileId}` };

    const shareId = crypto.randomUUID();
    const token = generateSecureToken(32);
    const now = new Date().toISOString();

    let expiresAt: string | null = null;
    if (expiresAtStr) {
      try {
        new Date(expiresAtStr);
        expiresAt = expiresAtStr;
      } catch {
        return { error: '无效的过期时间格式' };
      }
    }

    await db.insert(shares).values({
      id: shareId,
      userId,
      fileId,
      password: password || null,
      expiresAt,
      downloadLimit: maxVisits || null,
      downloadCount: 0,
      isUploadLink: false,
      uploadToken: null,
      createdAt: now,
    });

    const shareUrl = `/share/${shareId}`;

    return {
      success: true,
      message: `分享链接已创建`,
      shareId,
      url: shareUrl,
      hasPassword: !!password,
      expiresAt,
      downloadLimit: maxVisits,
      fileName: file.name,  // 从 file 对象获取，不存储在 shares 表
      _next_actions: [
        '✅ 分享链接已创建',
        '可通过 list_shares 查看所有分享',
        '可通过 update_share 修改设置',
        '可通过 revoke_share 撤销分享',
      ],
    };
  }

  static async executeListShares(env: Env, userId: string, args: Record<string, unknown>) {
    const includeExpired = args.includeExpired === true;
    const fileId = args.fileId as string | undefined;
    const limit = Math.min((args.limit as number) || 20, 100);
    const db = getDb(env.DB);

    const conditions: any[] = [eq(shares.userId, userId)];
    if (!includeExpired) {
      conditions.push(or(isNull(shares.expiresAt), gte(shares.expiresAt, new Date().toISOString())));
    }
    if (fileId) {
      conditions.push(eq(shares.fileId, fileId));
    }

    const rows = await db
      .select()
      .from(shares)
      .where(and(...conditions))
      .orderBy(desc(shares.createdAt))
      .limit(limit)
      .all();

    return {
      total: rows.length,
      includeExpired,
      shares: rows.map((s) => ({
        id: s.id,
        fileId: s.fileId,
        url: `/share/${s.id}`,
        hasPassword: !!s.password,
        isUploadLink: s.isUploadLink,
        downloads: Number(s.downloadCount) || 0,
        downloadLimit: s.downloadLimit,
        expiresAt: s.expiresAt,
        isActive: !s.expiresAt || new Date(s.expiresAt) > new Date(),
        createdAt: s.createdAt,
      })),
    };
  }

  static async executeUpdateShare(env: Env, userId: string, args: Record<string, unknown>) {
    const shareId = args.shareId as string;
    const db = getDb(env.DB);

    const share = await db.select().from(shares)
      .where(and(eq(shares.id, shareId), eq(shares.userId, userId)))
      .get();
    if (!share) return { error: '分享链接不存在' };

    const updates: Record<string, any> = {};
    if ('password' in args && args.password !== undefined) updates.password = (args.password as string) || null;
    if ('expiresAt' in args && args.expiresAt !== undefined) updates.expiresAt = (args.expiresAt as string) || null;
    if ('maxVisits' in args && args.maxVisits !== undefined) updates.downloadLimit = (args.maxVisits as number) || null;

    await db.update(shares).set(updates).where(eq(shares.id, shareId));

    return {
      success: true,
      message: '分享设置已更新',
      shareId,
      changes: Object.keys(updates),
    };
  }

  static async executeRevokeShare(env: Env, userId: string, args: Record<string, unknown>) {
    const shareId = args.shareId as string;
    const reason = args.reason as string | undefined;
    const db = getDb(env.DB);

    await db.delete(shares)
      .where(and(eq(shares.id, shareId), eq(shares.userId, userId)))
      .run();

    logger.info('AgentTool', 'Revoked share link', { shareId, reason: reason || '(none)' });

    return {
      success: true,
      message: '分享链接已撤销',
      shareId,
      revokedAt: new Date().toISOString(),
    };
  }

  static async executeGetShareDetails(env: Env, userId: string, args: Record<string, unknown>) {
    const shareId = args.shareId as string;
    const db = getDb(env.DB);

    const share = await db.select().from(shares)
      .where(and(eq(shares.id, shareId), eq(shares.userId, userId)))
      .get();
    if (!share) return { error: '分享链接不存在' };

    return {
      id: share.id,
      fileId: share.fileId,
      url: `/share/${share.id}`,
      hasPassword: !!share.password,
      isUploadLink: share.isUploadLink,
      stats: {
        totalDownloads: Number(share.downloadCount) || 0,
        downloadLimit: share.downloadLimit,
        remainingDownloads: share.downloadLimit ? Math.max(0, share.downloadLimit - (Number(share.downloadCount) || 0)) : null,
      },
      timeInfo: {
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        isExpired: share.expiresAt ? new Date(share.expiresAt) < new Date() : false,
        remainingTime: share.expiresAt ? getTimeRemaining(share.expiresAt) : null,
      },
    };
  }

  static async executeCreateDirectLink(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const expiresInHours = Math.min((args.expiresInHours as number) || 168, 720); // 最大30天
    const maxDownloads = args.maxDownloads as number | undefined;
    const db = getDb(env.DB);

    const file = await db.select().from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();
    if (!file) return { error: '文件不存在或无权访问' };

    const directLinkToken = generateSecureToken(48);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();

    await db.update(files).set({
      directLinkToken,
      directLinkExpiresAt: expiresAt,
      updatedAt: new Date().toISOString(),
    }).where(eq(files.id, fileId));

    logger.info('AgentTool', 'Created direct link', { fileId, fileName: file.name, expiresInHours });

    return {
      success: true,
      message: '直链已创建',
      fileId,
      fileName: file.name,
      url: `/dl/${directLinkToken}`,
      expiresAt,
      expiresInHours,
      maxDownloads,
      warning: '⚠️ 直链无需登录即可下载，请谨慎分享！',
      _next_actions: [
        '✅ 直链已创建',
        '可通过 revoke_direct_link 紧急撤销',
      ],
    };
  }

  static async executeRevokeDirectLink(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const db = getDb(env.DB);

    const file = await db.select().from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId)))
      .get();
    if (!file) return { error: '文件不存在' };

    await db.update(files).set({
      directLinkToken: null,
      directLinkExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(files.id, fileId));

    logger.info('AgentTool', 'Revoked direct link', { fileId, fileName: file.name });

    return {
      success: true,
      message: '直链已撤销',
      fileId,
      fileName: file.name,
      revokedAt: new Date().toISOString(),
    };
  }

  static async executeCreateUploadLinkForFolder(env: Env, userId: string, args: Record<string, unknown>) {
    const folderId = args.folderId as string;
    const password = args.password as string | undefined;
    const expiresInHours = Math.min((args.expiresInHours as number) || 72, 720); // 最大30天
    const allowedMimeTypes = args.allowedMimeTypes as string[] | undefined;
    const maxSizeBytes = args.maxSizeBytes as number | undefined;
    const maxUploads = args.maxUploads as number | undefined;
    const db = getDb(env.DB);

    const folder = await db.select().from(files)
      .where(and(eq(files.id, folderId), eq(files.userId, userId), eq(files.isFolder, true)))
      .get();
    if (!folder) return { error: '文件夹不存在' };

    const uploadLinkId = crypto.randomUUID();
    const token = generateSecureToken(40);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    await db.insert(shares).values({
      id: uploadLinkId,
      userId,
      fileId: folderId,
      password: password || null,
      expiresAt,
      downloadLimit: maxUploads || null,
      downloadCount: 0,
      isUploadLink: true,
      uploadToken: token,
      maxUploadSize: maxSizeBytes || null,
      uploadAllowedMimeTypes: allowedMimeTypes?.join(',') || null,
      maxUploadCount: maxUploads || null,
      uploadCount: 0,
      createdAt: now,
    });

    return {
      success: true,
      message: '上传链接已创建',
      uploadLinkId,
      url: `/upload/${token}`,
      folderName: folder.name,
      hasPassword: !!password,
      allowedMimeTypes: allowedMimeTypes || '不限',
      maxSizeBytes: maxSizeBytes ? formatSize(maxSizeBytes) : '不限',
      maxUploads,
      expiresAt,
      expiresInHours,
      securityTip: password ? '✅ 已设置密码保护' : '⚠️ 未设置密码，任何人都可以上传',
      _next_actions: [
        '✅ 上传链接已创建',
        '可通过 list_shares(isUploadLink=true) 查看',
        '可通过 revoke_share 撤销',
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

function generateSecureToken(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values).map((v) => chars[v % chars.length]).join('');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getTimeRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return '已过期';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}天${hours % 24}小时`;
  return `${hours}小时${Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))}分钟`;
}
