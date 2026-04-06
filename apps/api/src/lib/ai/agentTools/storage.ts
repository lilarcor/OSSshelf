/**
 * storage.ts — 存储空间管理工具
 *
 * 功能:
 * - 存储使用情况统计
 * - 大文件发现
 * - 空间清理建议
 * - 文件类型分布
 */

import { eq, and, isNull, desc, sql, count } from 'drizzle-orm';
import { getDb, files, storageBuckets } from '../../../db';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition } from './types';
import { formatBytes } from '../utils';

export const definitions: ToolDefinition[] = [
  // 1. get_storage_usage — 存储概览
  {
    type: 'function',
    function: {
      name: 'get_storage_usage',
      description: `【空间概况】查看存储空间的使用情况。
适用场景：
• "我的空间用得怎么样"
• "还剩多少空间"
• "哪些东西占空间大"

提供总览：已用/剩余、文件数量、文件夹数量等`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // 2. get_large_files — 大文件列表
  {
    type: 'function',
    function: {
      name: 'get_large_files',
      description: `【大文件】找出占用空间最多的文件。
适用场景：
• "找一下大文件"
• "什么占的空间最多"
• "清理一些大文件"

帮助释放存储空间`,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量（默认20）' },
          minSize: { type: 'number', description: '最小大小（字节），如 10*1024*1024=10MB' },
        },
      },
    },
  },

  // 3. get_file_type_distribution — 类型分布
  {
    type: 'function',
    function: {
      name: 'get_file_type_distribution',
      description: `【类型分布】按文件类型统计存储使用情况。
适用场景：
• "我的文件都是什么类型的"
• "图片占多少空间"
• "文档和视频的比例"

帮助了解文件构成`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // 4. get_folder_sizes — 文件夹大小
  {
    type: 'function',
    function: {
      name: 'get_folder_sizes',
      description: `【文件夹占用】查看各文件夹的存储占用情况。
适用场景：
• "哪个文件夹最大"
• "工作目录占多少空间"
• "清理特定文件夹"`,
      parameters: {
        type: 'object',
        properties: {
          topN: { type: 'number', description: '显示最大的 N 个（默认10）' },
          folderId: { type: 'string', description: '指定父文件夹（可选，不传则全局）' },
        },
      },
    },
  },

  // 5. get_cleanup_suggestions — 清理建议
  {
    type: 'function',
    function: {
      name: 'get_cleanup_suggestions',
      description: `【清理建议】智能分析并提供空间清理建议。
适用场景：
• "帮我清理一下空间"
• "有什么可以删的"
• "优化存储使用"

会分析：重复文件、过期分享、大文件、空文件夹等`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
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
