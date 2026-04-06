/**
 * storage.ts — 存储桶管理工具
 *
 * 功能:
 * - 列出存储桶
 * - 存储桶详情
 * - 设置默认存储桶
 * - 迁移文件到其他桶
 */

import { eq, and, isNull, count, sql, desc } from 'drizzle-orm';
import { getDb, files, storageBuckets } from '../../../db';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition } from './types';
import { formatBytes } from '../utils';

export const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_buckets',
      description: `【列出存储桶】列出所有可用的存储桶及其状态。
显示每个桶的容量、文件数量、连接状态等。`,
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
      name: 'get_bucket_info',
      description: `【存储桶详情】获取指定存储桶的详细信息。
包括配置参数、使用统计、连接状态等。`,
      parameters: {
        type: 'object',
        properties: {
          bucketId: { type: 'string', description: '存储桶 ID' },
        },
        required: ['bucketId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_default_bucket',
      description: `【设置默认桶】指定新上传文件的默认存储桶。
适用场景："以后的新文件存到R2桶"`,
      parameters: {
        type: 'object',
        properties: {
          bucketId: { type: 'string', description: '要设为默认的存储桶 ID' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['bucketId', '_confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'migrate_file_to_bucket',
      description: `【迁移文件】将文件从一个存储桶迁移到另一个存储桶。
⚠️ 大文件可能需要较长时间，请耐心等待。
适用场景："把这个文件移到S3桶"、"迁移重要数据到备用存储"`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '要迁移的文件 ID' },
          targetBucketId: { type: 'string', description: '目标存储桶 ID' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileId', 'targetBucketId', '_confirmed'],
      },
    },
  },
];

export class StorageTools {

  static async executeListBuckets(env: Env, userId: string, _args: Record<string, unknown>) {
    const db = getDb(env.DB);

    try {
      const buckets = await db.select()
        .from(storageBuckets)
        .where(eq(storageBuckets.userId, userId))
        .all();

      const bucketsWithStats = await Promise.all(
        buckets.map(async (bucket) => {
          const stats = await db
            .select({
              totalSize: sql<number>`COALESCE(SUM(${files.size}), 0)`,
              fileCount: count(),
            })
            .from(files)
            .where(
              and(
                eq(files.userId, userId),
                eq(files.bucketId, bucket.id),
                isNull(files.deletedAt),
                eq(files.isFolder, false)
              )
            )
            .get();

          return {
            id: bucket.id,
            name: bucket.name,
            provider: bucket.provider,
            endpoint: bucket.endpoint ? maskEndpoint(bucket.endpoint) : null,
            isActive: bucket.isActive,
            isDefault: bucket.isDefault,
            totalSize: formatBytes(stats?.totalSize || 0),
            totalSizeBytes: stats?.totalSize || 0,
            fileCount: Number(stats?.fileCount) || 0,
            createdAt: bucket.createdAt,
          };
        })
      );

      return {
        total: bucketsWithStats.length,
        buckets: bucketsWithStats,
      };
    } catch (error) {
      logger.warn('AgentTool', 'Failed to list storage buckets', undefined, error);
      return {
        total: 0,
        buckets: [],
        note: '存储桶功能可能未完全启用',
      };
    }
  }

  static async executeGetBucketInfo(env: Env, userId: string, args: Record<string, unknown>) {
    const bucketId = args.bucketId as string;
    const db = getDb(env.DB);

    const bucket = await db.select()
      .from(storageBuckets)
      .where(and(eq(storageBuckets.id, bucketId), eq(storageBuckets.userId, userId)))
      .get();
    if (!bucket) return { error: '存储桶不存在' };

    const [stats, recentFiles] = await Promise.all([
      db
        .select({
          totalSize: sql<number>`COALESCE(SUM(${files.size}), 0)`,
          fileCount: count(),
          folderCount: sql<number>`COUNT(*) FILTER (WHERE ${files.isFolder} = TRUE)`,
        })
        .from(files)
        .where(
          and(
            eq(files.userId, userId),
            eq(files.bucketId, bucketId),
            isNull(files.deletedAt)
          )
        )
        .get(),
      db
        .select({ id: files.id, name: files.name, size: files.size, mimeType: files.mimeType, createdAt: files.createdAt })
        .from(files)
        .where(and(eq(files.userId, userId), eq(files.bucketId, bucketId), isNull(files.deletedAt)))
        .orderBy(desc(files.createdAt))
        .limit(5)
        .all(),
    ]);

    return {
      id: bucket.id,
      name: bucket.name,
      provider: bucket.provider,
      endpoint: bucket.endpoint,
      region: bucket.region,
      isActive: bucket.isActive,
      isDefault: bucket.isDefault,
      stats: {
        totalSize: formatBytes(stats?.totalSize || 0),
        totalSizeBytes: stats?.totalSize || 0,
        fileCount: Number(stats?.fileCount) || 0,
        folderCount: Number(stats?.folderCount) || 0,
      },
      recentFiles: (recentFiles || []).map((f) => ({
        id: f.id,
        name: f.name,
        size: formatBytes(f.size),
        mimeType: f.mimeType,
        createdAt: f.createdAt,
      })),
      createdAt: bucket.createdAt,
    };
  }

  static async executeSetDefaultBucket(env: Env, userId: string, args: Record<string, unknown>) {
    const bucketId = args.bucketId as string;
    const db = getDb(env.DB);

    const bucket = await db.select()
      .from(storageBuckets)
      .where(and(eq(storageBuckets.id, bucketId), eq(storageBuckets.userId, userId)))
      .get();
    if (!bucket) return { error: '存储桶不存在' };

    await db.update(storageBuckets).set({ isDefault: false })
      .where(and(eq(storageBuckets.userId, userId), eq(storageBuckets.isDefault, true)));

    await db.update(storageBuckets).set({ isDefault: true })
      .where(eq(storageBuckets.id, bucketId));

    logger.info('AgentTool', 'Set default bucket', { bucketId, bucketName: bucket.name, userId });

    return {
      success: true,
      message: `"${bucket.name}" 已设为默认存储桶`,
      bucketId,
      bucketName: bucket.name,
      provider: bucket.provider,
    };
  }

  static async executeMigrateFileToBucket(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const targetBucketId = args.targetBucketId as string;
    const db = getDb(env.DB);

    const [file, targetBucket] = await Promise.all([
      db.select().from(files).where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt))).get(),
      db.select().from(storageBuckets).where(and(eq(storageBuckets.id, targetBucketId), eq(storageBuckets.userId, userId))).get(),
    ]);

    if (!file) return { error: '文件不存在或无权访问' };
    if (!targetBucket) return { error: '目标存储桶不存在' };
    if (file.isFolder) return { error: '暂不支持迁移文件夹' };

    try {
      const sourceObject = await env.FILES?.get(file.r2Key!);
      if (!sourceObject) return { error: '源文件数据不可用' };

      const body = await sourceObject.arrayBuffer();
      const newR2Key = `uploads/${userId}/${fileId}/${file.name}`;

      await env.FILES?.put(newR2Key, new Uint8Array(body));

      await db.update(files).set({
        bucketId: targetBucketId,
        r2Key: newR2Key,
        updatedAt: new Date().toISOString(),
      }).where(eq(files.id, fileId));

      logger.info('AgentTool', 'Migrated file to different bucket', {
        fileId,
        fileName: file.name,
        fromBucket: file.bucketId || 'default',
        toBucket: targetBucketId,
        toBucketName: targetBucket.name,
      });

      return {
        success: true,
        message: `"${file.name}" 已迁移到 "${targetBucket.name}"`,
        fileId,
        fileName: file.name,
        fromBucket: file.bucketId || 'default',
        toBucket: targetBucketId,
        toBucketName: targetBucket.name,
        size: formatBytes(file.size),
      };
    } catch (error) {
      logger.error('AgentTool', 'Failed to migrate file', { fileId, targetBucketId }, error);
      return { error: '迁移失败: ' + (error instanceof Error ? error.message : '存储服务异常') };
    }
  }
}

function maskEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.protocol + '//' + url.hostname + '/***';
  } catch {
    return endpoint.replace(/\/\/[^@]+@/, '//***@');
  }
}
