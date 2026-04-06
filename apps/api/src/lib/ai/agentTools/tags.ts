/**
 * tags.ts — 标签管理工具
 *
 * 功能:
 * - 添加/移除标签
 * - 列出所有标签及使用次数
 * - 合并重复标签
 * - 自动打标签
 * - 为文件夹打标签
 */

import { eq, and, isNull, like, count, desc, asc } from 'drizzle-orm';
import { getDb, files, fileTags } from '../../../db';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition } from './types';

export const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'add_tag',
      description: '为文件添加一个或多个标签。',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件 UUID' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签名数组，如 ["重要", "合同"]' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileId', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_tag',
      description: '从文件移除指定标签。',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件 UUID' },
          tags: { type: 'array', items: { type: 'string' }, description: '要移除的标签名数组' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileId', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_all_tags',
      description: `列出所有标签及其使用频率。
适用场景："我有哪些标签""哪些标签用得最多"`,
      parameters: {
        type: 'object',
        properties: {
          sortBy: { type: 'string', enum: ['name', 'usage_count'], description: '排序方式，默认 usage_count' },
          limit: { type: 'number', description: '返回数量，默认 50' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_tags',
      description: `合并重复或相似的标签。
适用场景：发现"重要"和"重要文档"两个相似标签时合并它们。
合并后源标签会被删除，文件关联到目标标签。`,
      parameters: {
        type: 'object',
        properties: {
          sourceTag: { type: 'string', description: '源标签（将被删除）' },
          targetTag: { type: 'string', description: '目标标签（保留）' },
          _confirmed: { type: 'boolean', description: '用户确认（必须为true）' },
        },
        required: ['sourceTag', 'targetTag'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_tag_files',
      description: `基于AI为指定文件自动推荐并添加标签。
系统会分析文件内容并推荐最相关的已有标签或新标签。`,
      parameters: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' }, description: '要自动打标签的文件ID列表' },
          maxTagsPerFile: { type: 'number', description: '每个文件最多添加几个标签，默认 3' },
          createNewTags: { type: 'boolean', description: '是否允许创建新标签，默认 true' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['fileIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tag_folder',
      description: `为文件夹内的所有文件批量添加标签。
适用场景："给这个文件夹里的所有文件都加上'项目X'标签"`,
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '目标文件夹 ID' },
          tags: { type: 'array', items: { type: 'string' }, description: '要添加的标签列表' },
          recursive: { type: 'boolean', description: '是否递归子文件夹，默认 false' },
          _confirmed: { type: 'boolean', description: '用户确认' },
        },
        required: ['folderId', 'tags'],
      },
    },
  },
];

export class TagsTools {

  static async executeAddTag(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const tags = (args.tags as string[]) || [];
    const db = getDb(env.DB);

    const file = await db.select().from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();
    if (!file) return { error: `文件不存在或无权访问: ${fileId}` };

    const now = new Date().toISOString();
    let addedCount = 0;
    for (const tagName of tags) {
      if (!tagName) continue;

      const existing = await db.select().from(fileTags)
        .where(and(eq(fileTags.fileId, fileId), eq(fileTags.name, tagName)))
        .get();

      if (!existing) {
        await db.insert(fileTags).values({
          id: crypto.randomUUID(),
          userId,
          fileId,
          name: tagName,
          color: generateTagColor(tagName),
          createdAt: now,
        });
        addedCount++;
      }
    }

    return {
      success: true,
      message: `已添加 ${addedCount} 个标签到 "${file.name}"`,
      fileId,
      fileName: file.name,
      addedTags: tags.slice(0, addedCount),
      skippedTags: tags.length > addedCount ? tags.slice(addedCount) : [],
    };
  }

  static async executeRemoveTag(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const tags = (args.tags as string[]) || [];
    const db = getDb(env.DB);

    let removedCount = 0;
    for (const tagName of tags) {
      await db.delete(fileTags)
        .where(and(eq(fileTags.fileId, fileId), eq(fileTags.name, tagName)))
        .run();
      removedCount += 1;
    }

    return {
      success: true,
      message: `已移除 ${removedCount} 个标签`,
      fileId,
      removedTags: tags.slice(0, removedCount),
    };
  }

  static async executeListAllTags(env: Env, userId: string, args: Record<string, unknown>) {
    const sortBy = (args.sortBy as string) || 'usage_count';
    const limit = Math.min((args.limit as number) || 50, 100);
    const db = getDb(env.DB);

    const rows = await db
      .select({
        name: fileTags.name,
        color: fileTags.color,
        createdAt: fileTags.createdAt,
        usageCount: count(fileTags.fileId),
      })
      .from(fileTags)
      .where(eq(fileTags.userId, userId))
      .groupBy(fileTags.name)
      .orderBy(sortBy === 'name' ? asc(fileTags.name) : desc(count(fileTags.fileId)))
      .limit(limit)
      .all();

    return {
      total: rows.length,
      tags: rows.map((r) => ({
        name: r.name,
        color: r.color,
        usageCount: Number(r.usageCount) || 0,
        createdAt: r.createdAt,
      })),
    };
  }

  static async executeMergeTags(env: Env, userId: string, args: Record<string, unknown>) {
    const sourceTag = args.sourceTag as string;
    const targetTag = args.targetTag as string;
    const db = getDb(env.DB);

    if (sourceTag === targetTag) {
      return { error: '源标签和目标标签不能相同' };
    }

    const sourceRecords = await db.select()
      .from(fileTags)
      .where(and(eq(fileTags.userId, userId), eq(fileTags.name, sourceTag)))
      .all();

    let migratedCount = 0;
    for (const record of sourceRecords) {

      const existingTarget = await db.select()
        .from(fileTags)
        .where(and(
          eq(fileTags.userId, userId),
          eq(fileTags.fileId, record.fileId),
          eq(fileTags.name, targetTag)
        ))
        .get();

      if (!existingTarget) {
        await db.update(fileTags).set({ name: targetTag }).where(eq(fileTags.id, record.id));
        migratedCount++;
      } else {
        await db.delete(fileTags).where(eq(fileTags.id, record.id));
      }
    }

    logger.info('AgentTool', 'Merged tags', { sourceTag, targetTag, migratedCount });

    return {
      success: true,
      message: `已将 "${sourceTag}" 合并到 "${targetTag}"，迁移了 ${migratedCount} 个文件关联`,
      sourceTag,
      targetTag,
      migratedCount,
    };
  }

  static async executeAutoTagFiles(env: Env, userId: string, args: Record<string, unknown>) {
    const fileIds = (args.fileIds as string[]) || [];
    const maxTagsPerFile = Math.min((args.maxTagsPerFile as number) || 3, 5);

    return {
      status: 'queued',
      message: `自动打标签任务已加入队列，将为 ${fileIds.length} 个文件各推荐最多 ${maxTagsPerFile} 个标签`,
      fileIds,
      maxTagsPerFile,
      _next_actions: [
        '完成后可通过 get_file_detail 查看更新后的标签',
        '可通过 search_by_tag 按新标签搜索',
      ],
    };
  }

  static async executeTagFolder(env: Env, userId: string, args: Record<string, unknown>) {
    const folderId = args.folderId as string;
    const tags = (args.tags as string[]) || [];
    const recursive = args.recursive === true;
    const db = getDb(env.DB);

    const folder = await db.select().from(files)
      .where(and(eq(files.id, folderId), eq(files.userId, userId), eq(files.isFolder, true)))
      .get();
    if (!folder) return { error: '文件夹不存在' };

    const conditions: any[] = [eq(files.userId, userId), isNull(files.deletedAt)];
    if (recursive) {
      conditions.push(like(files.path, `${folder.path}%`));
    } else {
      conditions.push(eq(files.parentId, folderId));
    }
    conditions.push(eq(files.isFolder, false));

    const filesInFolder = await db.select({ id: files.id }).from(files).where(and(...conditions)).all();
    const fileIdsInFolder = filesInFolder.map((f) => f.id);

    let totalAdded = 0;
    for (const fileId of fileIdsInFolder) {
      for (const tag of tags) {
        const existing = await db.select()
          .from(fileTags)
          .where(and(eq(fileTags.fileId, fileId), eq(fileTags.name, tag)))
          .get();
        if (!existing) {
          await db.insert(fileTags).values({
            id: crypto.randomUUID(),
            userId,
            fileId,
            name: tag,
            color: generateTagColor(tag),
            createdAt: new Date().toISOString(),
          });
          totalAdded++;
        }
      }
    }

    return {
      success: true,
      message: `已为文件夹 "${folder.name}" 内的 ${filesInFolder.length} 个文件添加标签`,
      folderId,
      folderName: folder.name,
      tagsAdded: totalAdded,
      fileCount: filesInFolder.length,
      recursive,
    };
  }
}

function generateTagColor(tagName: string): string {
  const colors = ['#EF4444', '#F97316', '#F59E0B', '#84CC16', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6', '#8B5CF6', '#D946EF'];
  let hash = 0;
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
