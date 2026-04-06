/**
 * search.ts — 搜索与发现类工具
 *
 * 功能:
 * - 语义+FTS混合搜索
 * - 结构化多维过滤
 * - 标签搜索
 * - 重复文件查找
 * - 智能搜索路由（新增）
 * - 标签总览（新增）
 */

import { eq, and, isNull, isNotNull, desc, asc, like, or, inArray, count, gte, lte, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import {
  getDb,
  files,
  fileTags,
  shares,
  userStars,
} from '../../../db';
import { searchAndFetchFiles } from '../../vectorIndex';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition, AgentFile, ToolResultBase } from './types';
import { formatBytes, getMimeTypeCategory } from '../utils';

// ─────────────────────────────────────────────────────────────────────────────
// 工具定义
// ─────────────────────────────────────────────────────────────────────────────

export const definitions: ToolDefinition[] = [
  // 1. search_files — 语义+FTS混合搜索
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: `【核心搜索】语义向量搜索 + 全文检索混合，覆盖文件名/描述/AI摘要/AI标签四个字段。
适用场景：
- 用户明确说要"找""搜"某类或某个文件
- 关键词搜索：2-5 个核心词，避免完整句子
- 支持 mimeTypePrefix 按文件类型过滤（如 "image/" "video/" "application/pdf"）
⚠️ 返回 0 结果时：不要重试超过 2 次，改用 filter_files 按类型浏览
⚠️ 找到图片时：调用 analyze_image 进行视觉确认`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（2-5个核心词）' },
          limit: { type: 'number', description: '结果数量，默认 10，最大 30' },
          mimeTypePrefix: { type: 'string', description: '类型过滤，如 "image/" "video/" "text/" "application/pdf"' },
          folderId: { type: 'string', description: '限定在某文件夹内搜索' },
        },
        required: ['query'],
      },
    },
  },

  // 2. filter_files — 结构化多维过滤
  {
    type: 'function',
    function: {
      name: 'filter_files',
      description: `【结构化过滤】通过多维条件组合筛选文件，不依赖关键词匹配。
适用场景：
- "找所有图片" / "找大文件" / "最近一周上传的文件"
- 搜索无结果时的备选方案
- 需要视觉筛选时（先 filter_files 获取图片列表，再 analyze_image 逐张判断）`,
      parameters: {
        type: 'object',
        properties: {
          mimeTypePrefix: { type: 'string', description: '文件类型前缀，如 "image/" "video/" "audio/"' },
          hasAiSummary: { type: 'boolean', description: '仅返回已有 AI 摘要的文件' },
          hasVectorIndex: { type: 'boolean', description: '仅返回已建立向量索引的文件' },
          isStarred: { type: 'boolean', description: '仅返回收藏的文件' },
          minSizeBytes: { type: 'number', description: '最小文件大小（字节）' },
          maxSizeBytes: { type: 'number', description: '最大文件大小（字节）' },
          createdAfter: { type: 'string', description: '创建时间起（ISO 8601）' },
          createdBefore: { type: 'string', description: '创建时间止（ISO 8601）' },
          folderId: { type: 'string', description: '限定在某文件夹内，不传则全局' },
          sortBy: {
            type: 'string',
            enum: ['newest', 'oldest', 'largest', 'smallest', 'name_asc', 'name_desc'],
            description: '排序方式，默认 newest',
          },
          limit: { type: 'number', description: '结果数量，默认 20，最大 100' },
        },
        required: [],
      },
    },
  },

  // 3. search_by_tag — 标签搜索
  {
    type: 'function',
    function: {
      name: 'search_by_tag',
      description: '按标签精确或模糊搜索文件。支持同时搜索多个标签（AND 逻辑：文件必须包含所有标签）。',
      parameters: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签名数组，如 ["重要", "合同"]。多个标签取交集（AND）',
          },
          matchMode: {
            type: 'string',
            enum: ['any', 'all'],
            description: '"any"=包含任意一个标签（OR），"all"=包含所有标签（AND）。默认 any',
          },
          limit: { type: 'number', description: '结果数量，默认 20' },
        },
        required: ['tags'],
      },
    },
  },

  // 4. search_duplicates — 重复文件查找
  {
    type: 'function',
    function: {
      name: 'search_duplicates',
      description: '查找重复文件（相同内容哈希的文件）。适合用户问"有没有重复文件"时使用。',
      parameters: {
        type: 'object',
        properties: {
          mimeTypePrefix: { type: 'string', description: '可选：只查找某类型的重复文件' },
          limit: { type: 'number', description: '返回重复组数量，默认 10' },
        },
        required: [],
      },
    },
  },

  // 5. smart_search — 智能搜索路由（新增）
  {
    type: 'function',
    function: {
      name: 'smart_search',
      description: `【智能搜索引擎】自动选择最佳搜索策略。
根据查询特征自动路由到合适的搜索工具：
- 包含具体文件名 → 精确匹配 (filter_files)
- 包含语义概念 → 向量语义搜索 (search_files)
- 包含标签 → 标签搜索 (search_by_tag)
- 包含路径 → 路径模式匹配
- 拼写不确定 → 模糊匹配

适用场景：
- 不确定该用哪种搜索方式时
- 自然语言查询："找我的照片"、"最近的文档"、"重要的文件"`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（自然语言）' },
          intent: {
            type: 'string',
            enum: ['auto', 'filename', 'semantic', 'tag', 'path', 'fuzzy'],
            description: '搜索意图，默认 auto（自动检测）',
          },
          limit: { type: 'number', description: '结果数量，默认 10' },
        },
        required: ['query'],
      },
    },
  },

  // 6. list_all_tags — 标签总览（新增）
  {
    type: 'function',
    function: {
      name: 'list_all_tags',
      description: `列出用户所有的标签及其使用次数、颜色等信息。
适用场景：
- 查看有哪些可用标签
- 了解标签的使用频率
- 为打标签提供参考`,
      parameters: {
        type: 'object',
        properties: {
          includeUsageCount: { type: 'boolean', description: '是否包含每个标签的使用次数，默认 true' },
          sortBy: {
            type: 'string',
            enum: ['name', 'usage_count', 'created_at'],
            description: '排序方式，默认 usage_count',
          },
          limit: { type: 'number', description: '返回数量，默认 50' },
        },
        required: [],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 执行器类
// ─────────────────────────────────────────────────────────────────────────────

export class SearchTools {

  static async executeSearchFiles(env: Env, userId: string, args: Record<string, unknown>) {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 10, 30);
    const mimeTypePrefix = args.mimeTypePrefix as string | undefined;
    const folderId = args.folderId as string | undefined;

    const db = getDb(env.DB);
    let results: AgentFile[] = [];

    try {
      const vectorResults = await searchAndFetchFiles(env, query, userId, {
        limit: limit * 2,
        threshold: 0.22,
      });
      results = vectorResults
        .filter((f: InferSelectModel<typeof files>) => !mimeTypePrefix || (f.mimeType ?? '').startsWith(mimeTypePrefix))
        .filter((f: InferSelectModel<typeof files>) => !folderId || f.parentId === folderId)
        .map(toAgentFile);
    } catch (error) {
      logger.warn('AgentTool', 'Vector search failed, falling back to FTS', { query }, error);
    }

    if (results.length < 3) {
      const kws = query.split(/\s+/).slice(0, 4);
      const conditions: any[] = [
        eq(files.userId, userId),
        isNull(files.deletedAt),
        or(
          ...kws.flatMap((w) => [
            like(files.name, `%${w}%`),
            like(files.description, `%${w}%`),
            like(files.aiSummary, `%${w}%`),
            like(files.aiTags, `%${w}%`),
          ])
        ),
      ];
      if (mimeTypePrefix) conditions.push(like(files.mimeType, `${mimeTypePrefix}%`));
      if (folderId) conditions.push(eq(files.parentId, folderId));

      const kwRows = await db
        .select()
        .from(files)
        .where(and(...conditions))
        .orderBy(desc(files.updatedAt))
        .limit(limit)
        .all();

      const existing = new Set(results.map((r) => r.id));
      results = [...results, ...kwRows.filter((f) => !existing.has(f.id)).map(toAgentFile)].slice(0, limit);
    }

    const imageCount = results.filter((f) => f.mimeType?.startsWith('image/')).length;
    const textCount = results.filter((f) => isTextFile(f.mimeType) && !f.isFolder).length;

    const nextActions: string[] = [];
    if (results.length === 0) {
      nextActions.push('搜索无结果。建议：换同义词再试一次，或使用 filter_files 按类型浏览所有文件。');
    } else if (imageCount > 0 && imageCount <= 10) {
      nextActions.push(`找到 ${imageCount} 张图片。若需视觉确认是否符合描述，逐一调用 analyze_image（每次 1 张）。`);
    } else if (textCount > 0 && textCount <= 5) {
      nextActions.push(`找到 ${textCount} 个文本文件。若需了解内容，逐一调用 read_file_text。`);
    }

    return { total: results.length, files: results, _next_actions: nextActions };
  }

  static async executeFilterFiles(env: Env, userId: string, args: Record<string, unknown>) {
    const db = getDb(env.DB);
    const limit = Math.min((args.limit as number) || 20, 100);
    const sortBy = (args.sortBy as string) || 'newest';

    const conditions: any[] = [eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)];

    if (args.mimeTypePrefix) conditions.push(like(files.mimeType, `${args.mimeTypePrefix}%`));
    if (args.hasAiSummary === true) conditions.push(isNotNull(files.aiSummary));
    if (args.hasVectorIndex === true) conditions.push(isNotNull(files.vectorIndexedAt));
    if (args.isStarred === true) conditions.push(eq(files.isStarred, true));
    if (args.minSizeBytes) conditions.push(gte(files.size, args.minSizeBytes as number));
    if (args.maxSizeBytes) conditions.push(lte(files.size, args.maxSizeBytes as number));
    if (args.createdAfter) conditions.push(gte(files.createdAt, args.createdAfter as string));
    if (args.createdBefore) conditions.push(lte(files.createdAt, args.createdBefore as string));
    if (args.folderId) conditions.push(eq(files.parentId, args.folderId as string));

    const orderMap: Record<string, any> = {
      newest: desc(files.createdAt),
      oldest: asc(files.createdAt),
      largest: desc(files.size),
      smallest: asc(files.size),
      name_asc: asc(files.name),
      name_desc: desc(files.name),
    };

    const rows = await db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(orderMap[sortBy] ?? desc(files.createdAt))
      .limit(limit)
      .all();

    const results = rows.map(toAgentFile);
    const imageCount = results.filter((f) => f.mimeType?.startsWith('image/')).length;

    const nextActions: string[] = [];
    if (results.length === 0) {
      nextActions.push('过滤结果为空，请尝试放宽条件（减少过滤参数）。');
    } else if (imageCount > 0) {
      nextActions.push(`过滤出 ${imageCount} 张图片。若需视觉判断，调用 analyze_image 逐张分析。`);
    }

    return { total: results.length, files: results, _next_actions: nextActions };
  }

  static async executeSearchByTag(env: Env, userId: string, args: Record<string, unknown>) {
    const tags = args.tags as string[];
    const matchMode = (args.matchMode as string) || 'any';
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(env.DB);

    if (matchMode === 'all' && tags.length > 1) {
      const fileIdsWithTag = await Promise.all(
        tags.map((tag) =>
          db
            .select({ fileId: fileTags.fileId })
            .from(fileTags)
            .where(and(eq(fileTags.userId, userId), like(fileTags.name, `%${tag}%`)))
            .all()
            .then((rows) => new Set(rows.map((r) => r.fileId)))
        )
      );

      const intersection = fileIdsWithTag.reduce((acc, cur) => {
        return new Set([...acc].filter((id) => cur.has(id)));
      });

      if (intersection.size === 0) return { tags, matchMode, total: 0, files: [] };

      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.userId, userId),
            isNull(files.deletedAt),
            inArray(files.id, [...intersection].slice(0, limit))
          )
        )
        .all();

      return { tags, matchMode, total: rows.length, files: rows.map(toAgentFile) };
    }

    const rows = await db
      .select({ file: files, tag: fileTags })
      .from(fileTags)
      .innerJoin(files, eq(fileTags.fileId, files.id))
      .where(
        and(
          eq(fileTags.userId, userId),
          or(...tags.map((tag) => like(fileTags.name, `%${tag}%`))),
          isNull(files.deletedAt)
        )
      )
      .orderBy(desc(files.updatedAt))
      .limit(limit)
      .all();

    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      if (seen.has(r.file.id)) return false;
      seen.add(r.file.id);
      return true;
    });

    return {
      tags,
      matchMode,
      total: deduped.length,
      files: deduped.map((r) => ({ ...toAgentFile(r.file), matchedTag: r.tag.name })),
    };
  }

  static async executeSearchDuplicates(env: Env, userId: string, args: Record<string, unknown>) {
    const mimeTypePrefix = args.mimeTypePrefix as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);
    const db = getDb(env.DB);

    const conditions: any[] = [
      eq(files.userId, userId),
      isNull(files.deletedAt),
      isNotNull(files.hash),
      eq(files.isFolder, false),
    ];
    if (mimeTypePrefix) conditions.push(like(files.mimeType, `${mimeTypePrefix}%`));

    const hashGroups = await db
      .select({ hash: files.hash, cnt: count(files.id) })
      .from(files)
      .where(and(...conditions))
      .groupBy(files.hash)
      .having(sql`count(${files.id}) > 1`)
      .orderBy(desc(sql`count(${files.id})`))
      .limit(limit)
      .all();

    if (hashGroups.length === 0) {
      return { total: 0, duplicateGroups: [], message: '未发现重复文件' };
    }

    const hashes = hashGroups.map((g) => g.hash as string);
    const allDuplicates = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), inArray(files.hash, hashes)))
      .all();

    const groups = new Map<string, AgentFile[]>();
    for (const file of allDuplicates) {
      const h = file.hash as string;
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h)!.push(toAgentFile(file));
    }

    const duplicateGroups = [...groups.entries()].map(([hash, groupFiles]) => ({
      hash: hash.slice(0, 12) + '...',
      count: groupFiles.length,
      totalWastedSize: formatBytes((groupFiles.length - 1) * (groupFiles[0]?.size || 0)),
      files: groupFiles,
    }));

    return {
      total: hashGroups.length,
      duplicateGroups,
      _next_actions: ['找到重复文件。你可以告知用户哪些文件重复，建议保留哪个版本（如最新的）。'],
    };
  }

  static async executeSmartSearch(env: Env, userId: string, args: Record<string, unknown>) {
    const query = args.query as string;
    const intent = (args.intent as string) || 'auto';
    const limit = (args.limit as number) || 10;

    const detectedIntent = intent === 'auto' ? detectSearchIntent(query) : intent;

    switch (detectedIntent) {
      case 'filename':
        return await SearchTools.executeFilterFiles(env, userId, {
          ...args,
          namePattern: query,
          limit,
        });
      case 'semantic':
        return await SearchTools.executeSearchFiles(env, userId, {
          query,
          limit,
        });
      case 'tag':
        const tags = extractTagsFromQuery(query);
        return await SearchTools.executeSearchByTag(env, userId, {
          tags: tags.length > 0 ? tags : [query],
          limit,
        });
      case 'path':
        return await SearchTools.executeFilterFiles(env, userId, {
          ...args,
          pathPattern: query,
          limit,
        });
      default:
        return await SearchTools.executeSearchFiles(env, userId, {
          query,
          limit,
        });
    }
  }

  static async executeListAllTags(env: Env, userId: string, args: Record<string, unknown>) {
    const includeUsageCount = args.includeUsageCount !== false;
    const sortBy = (args.sortBy as string) || 'usage_count';
    const limit = Math.min((args.limit as number) || 50, 100);
    const db = getDb(env.DB);

    let rows;

    if (includeUsageCount) {
      rows = await db
        .select({
          id: fileTags.id,
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
    } else {
      rows = await db
        .select()
        .from(fileTags)
        .where(eq(fileTags.userId, userId))
        .limit(limit)
        .all();
    }

    return {
      total: rows.length,
      tags: rows.map((r) => ({
        name: r.name,
        color: r.color,
        usageCount: (r as any).usageCount || null,
        createdAt: r.createdAt,
      })),
      _next_actions: [
        '可使用 search_by_tag 按标签搜索文件',
        '可使用 add_tag / remove_tag 管理文件标签',
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

function toAgentFile(f: InferSelectModel<typeof files>): AgentFile {
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

function isTextFile(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('document') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('presentation')
  );
}

/** 检测搜索意图 */
function detectSearchIntent(query: string): string {
  if (query.includes('/') || query.includes('\\')) return 'path';
  if (query.startsWith('#') || query.includes('标签')) return 'tag';
  if (/^[\w\-\.]+\.\w{2,4}$/.test(query)) return 'filename';
  return 'semantic';
}

/** 从查询中提取可能的标签 */
function extractTagsFromQuery(query: string): string[] {
  const tagMatches = query.match(/#(\S+)/g);
  if (tagMatches) {
    return tagMatches.map((t) => t.slice(1));
  }
  return [];
}
