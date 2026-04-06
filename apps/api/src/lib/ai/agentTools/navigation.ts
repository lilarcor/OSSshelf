/**
 * navigation.ts — 目录导航与浏览工具
 *
 * 功能:
 * - 列出文件夹内容
 * - 目录树结构
 * - 路径导航（新增）
 * - 存储概览（新增）
 */

import { eq, and, isNull, desc, asc, count, sql, like } from 'drizzle-orm';
import { getDb, files } from '../../../db';
import type { Env } from '../../../types/env';
import type { ToolDefinition, AgentFile } from './types';
import { formatBytes, getMimeTypeCategory } from '../utils';

export const definitions: ToolDefinition[] = [
  // 1. list_folder — 列出文件夹内容
  {
    type: 'function',
    function: {
      name: 'list_folder',
      description: `【列出文件夹】获取某文件夹下的直接子文件/子文件夹。
⚠️ 用户问"有什么文件""看看XX目录"时使用。
⚠️ 必须传入 folderId（从其他工具返回的 id 字段）或 path。
⚠️ 返回结果中包含 isFolder 标识，可区分文件与文件夹。`,
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '目标文件夹 UUID（优先）' },
          folderPath: { type: 'string', description: '目标文件夹路径（备选）' },
          sortBy: {
            type: 'string',
            enum: ['name_asc', 'name_desc', 'newest', 'oldest', 'largest', 'smallest'],
            description: '排序方式，默认 name_asc',
          },
          limit: { type: 'number', description: '返回数量，默认 50' },
        },
        required: [],
      },
    },
  },

  // 2. get_folder_tree — 目录树结构
  {
    type: 'function',
    function: {
      name: 'get_folder_tree',
      description: `【目录树】返回根目录或指定文件夹的完整目录树（递归子文件夹）。
适用场景：
- "看看我的文件结构"
- "展示整个项目目录"
- 需要了解文件组织方式时`,
      parameters: {
        type: 'object',
        properties: {
          rootFolderId: { type: 'string', description: '起始文件夹 ID，不传则从根目录开始' },
          maxDepth: { type: 'number', description: '最大深度，默认 3' },
          includeFiles: { type: 'boolean', description: '是否包含文件（不仅是文件夹），默认 true' },
        },
        required: [],
      },
    },
  },

  // 3. navigate_path — 路径导航（新增）
  {
    type: 'function',
    function: {
      name: 'navigate_path',
      description: `【路径导航】通过路径字符串导航到指定位置并查看内容。
支持相对路径和绝对路径。
适用场景：
- "进入 /文档/工作" 文件夹
- "回到上一级"
- "打开备忘录文件夹"`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标路径（如 "/文档/工作" 或 "../上级"）' },
          currentFolderId: { type: 'string', description: '当前位置（用于相对路径解析）' },
          action: {
            type: 'string',
            enum: ['list', 'info', 'parent'],
            description: '操作类型：list=列出内容, info=路径信息, parent=返回父级',
          },
        },
        required: ['path'],
      },
    },
  },

  // 4. get_storage_overview — 存储概览（新增）
  {
    type: 'function',
    function: {
      name: 'get_storage_overview',
      description: `【存储概览】快速查看各文件夹的大小和使用情况。
适合用户问"我的空间用得怎么样""哪些文件夹占空间大"时使用。`,
      parameters: {
        type: 'object',
        properties: {
          topN: { type: 'number', description: '显示最大的 N 个文件夹，默认 10' },
          includeFileTypes: { type: 'boolean', description: '是否包含文件类型分布，默认 true' },
        },
        required: [],
      },
    },
  },
];

export class NavigationTools {

  static async executeListFolder(env: Env, userId: string, args: Record<string, unknown>) {
    const db = getDb(env.DB);
    let parentId: string | null = null;

    if (args.folderId) {
      const folder = await db.select().from(files)
        .where(and(eq(files.id, args.folderId as string), eq(files.userId, userId), isNull(files.deletedAt)))
        .get();
      if (!folder) return { error: `文件夹不存在: ${args.folderId}` };
      if (!folder.isFolder) return { error: `${args.folderId} 不是文件夹` };
      parentId = folder.id;
    } else if (args.folderPath) {
      const folder = await db.select().from(files)
        .where(
          and(eq(files.userId, userId), eq(files.path, args.folderPath as string), isNull(files.deletedAt))
        )
        .get();
      if (folder) parentId = folder.id;
    }

    const sortBy = (args.sortBy as string) || 'name_asc';
    const limit = Math.min((args.limit as number) || 50, 200);
    const orderMap: Record<string, any> = {
      name_asc: asc(files.name),
      name_desc: desc(files.name),
      newest: desc(files.createdAt),
      oldest: asc(files.createdAt),
      largest: desc(files.size),
      smallest: asc(files.size),
    };

    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), parentId ? eq(files.parentId, parentId) : isNull(files.parentId)))
      .orderBy(orderMap[sortBy] ?? asc(files.name))
      .limit(limit)
      .all();

    const children = rows.map(toAgentFile);
    const folderCount = children.filter((f) => f.isFolder).length;
    const fileCount = children.length - folderCount;

    return {
      folderId: parentId,
      children,
      total: children.length,
      folderCount,
      fileCount,
      _next_actions:
        folderCount > 0 ? ['如需进入某个子文件夹，请使用其 id 作为 folderId 调用本工具'] : [],
    };
  }

  static async executeGetFolderTree(env: Env, userId: string, args: Record<string, unknown>) {
    const rootFolderId = args.rootFolderId as string | undefined;
    const maxDepth = Math.min((args.maxDepth as number) || 3, 5);
    const includeFiles = args.includeFiles !== false;

    async function buildTree(parentId: string | null, depth: number): Promise<any[]> {
      if (depth <= 0) return [];

      const db = getDb(env.DB);
      const items = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.userId, userId),
            isNull(files.deletedAt),
            parentId ? eq(files.parentId, parentId) : isNull(files.parentId)
          )
        )
        .orderBy(asc(files.name))
        .limit(100)
        .all();

      return Promise.all(
        items.map(async (item) => {
          const node: any = {
            id: item.id,
            name: item.name,
            isFolder: item.isFolder,
            size: formatBytes(item.size),
          };

          if (item.isFolder && depth > 1) {
            node.children = await buildTree(item.id, depth - 1);
          }
          if (!item.isFolder && includeFiles) {
            node.mimeType = item.mimeType;
          }

          return node;
        })
      );
    }

    const tree = await buildTree(rootFolderId || null, maxDepth);

    function countNodes(nodes: any[]): { folders: number; files: number } {
      let folders = 0, files = 0;
      for (const n of nodes) {
        if (n.isFolder) {
          folders++;
          if (n.children) {
            const sub = countNodes(n.children);
            folders += sub.folders;
            files += sub.files;
          }
        } else {
          files++;
        }
      }
      return { folders, files };
    }

    const counts = countNodes(tree);

    return {
      tree,
      maxDepth,
      ...counts,
      _next_actions: ['如需查看某个文件夹内容，使用 list_folder 并传入对应 id'],
    };
  }

  static async executeNavigatePath(env: Env, userId: string, args: Record<string, unknown>) {
    const path = args.path as string;
    const currentFolderId = args.currentFolderId as string | undefined;
    const action = (args.action as string) || 'list';
    const db = getDb(env.DB);

    let targetId: string | null = null;

    if (path === '..' || path === '../' || path === 'parent') {
      if (!currentFolderId) {
        return { error: '需要提供 currentFolderId 才能返回父级' };
      }
      const current = await db.select().from(files)
        .where(and(eq(files.id, currentFolderId), eq(files.userId, userId)))
        .get();
      targetId = current?.parentId || null;
    } else if (path.startsWith('/') || path.startsWith('\\')) {
      const folder = await db.select().from(files)
        .where(
          and(eq(files.userId, userId), eq(files.path, path), isNull(files.deletedAt))
        )
        .get();
      targetId = folder?.id || null;
    } else {
      const current = currentFolderId
        ? await db.select().from(files).where(and(eq(files.id, currentFolderId), eq(files.userId, userId))).get()
        : null;

      const searchPath = current?.path
        ? `${current.path}/${path}`
        : `/${path}`;

      const folder = await db.select().from(files)
        .where(
          and(eq(files.userId, userId), like(files.path, `%${searchPath}%`), isNull(files.deletedAt))
        )
        .get();
      targetId = folder?.id || null;
    }

    switch (action) {
      case 'info':
        if (targetId) {
          const info = await db.select().from(files).where(eq(files.id, targetId)).get();
          return { path, targetId, info: toAgentFile(info!) };
        }
        return { path, targetId: null, message: '路径不存在' };

      case 'parent':
        if (targetId) {
          const parent = await db.select().from(files).where(eq(files.id, targetId)).get();
          return { path, parentId: targetId, parentName: parent?.name };
        }
        return { path, parentId: null, message: '已在根目录' };

      case 'list':
      default:
        if (targetId) {
          return await NavigationTools.executeListFolder(env, userId, { folderId: targetId });
        }
        return await NavigationTools.executeListFolder(env, userId, {});
    }
  }

  static async executeGetStorageOverview(env: Env, userId: string, args: Record<string, unknown>) {
    const topN = Math.min((args.topN as number) || 10, 20);
    const includeFileTypes = args.includeFileTypes !== false;
    const db = getDb(env.DB);

    const [totalStats, folderSizes, fileTypeDist] = await Promise.all([
      db
        .select({
          totalSize: sql<number>`COALESCE(SUM(${files.size}), 0)`,
          totalCount: count(),
        })
        .from(files)
        .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
        .get(),

      db
        .select({
          folderId: files.parentId,
          folderName: files.name,
          totalSize: sql<number>`SUM(${files.size})`,
          fileCount: count(),
        })
        .from(files)
        .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
        .groupBy(files.parentId)
        .orderBy(desc(sql`SUM(${files.size})`))
        .limit(topN)
        .all(),

      includeFileTypes
        ? db
            .select({
              mimeType: files.mimeType,
              count: count(),
              totalSize: sql<number>`SUM(${files.size})`,
            })
            .from(files)
            .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
            .groupBy(files.mimeType)
            .orderBy(desc(count()))
            .limit(15)
            .all()
        : [],
    ]);

    return {
      total: {
        size: formatBytes(totalStats?.totalSize || 0),
        sizeBytes: totalStats?.totalSize || 0,
        count: totalStats?.totalCount || 0,
      },
      topFolders: (folderSizes || []).map((f) => ({
        folderId: f.folderId,
        folderName: f.folderName || '(根目录)',
        size: formatBytes(f.totalSize || 0),
        sizeBytes: f.totalSize || 0,
        fileCount: Number(f.fileCount) || 0,
      })),
      ...(includeFileTypes
        ? {
            fileTypes: (fileTypeDist || []).map((t) => ({
              mimeType: t.mimeType || 'unknown',
              category: getMimeTypeCategory(t.mimeType),
              count: Number(t.count) || 0,
              size: formatBytes(t.totalSize || 0),
            })),
          }
        : {}),
      _next_actions: [
        '如需查看某文件夹详细内容，调用 list_folder 并传入 folderId',
      ],
    };
  }
}

function toAgentFile(f: any): AgentFile {
  return {
    id: f.id,
    name: f.name,
    path: f.path,
    isFolder: f.isFolder,
    mimeType: f.mimeType,
    size: f.size,
    sizeFormatted: formatBytes(f.size),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    parentId: f.parentId,
    aiSummary: f.aiSummary,
    aiTags: f.aiTags,
    description: f.description,
    isStarred: f.isStarred ?? false,
    currentVersion: f.currentVersion ?? null,
    vectorIndexedAt: f.vectorIndexedAt,
  };
}
