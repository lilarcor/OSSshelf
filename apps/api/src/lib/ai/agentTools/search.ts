/**
 * search.ts — 智能搜索与发现工具
 *
 * 功能:
 * - 语义搜索（向量搜索）
 * - 关键词搜索（全文检索）
 * - 智能路由（自动选择最佳搜索方式）
 * - 文件过滤与排序
 *
 * 智能特性：
 * - 自动拆分中文关键词（"文档资料共享" → ["文档", "资料", "共享"]）
 * - 多策略融合（向量 + FTS + 元数据）
 * - 自然语言理解（支持口语化表达）
 */

import { eq, and, isNull, isNotNull, desc, asc, like, or, inArray, count, gte, lte, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, files, fileTags, shares, userStars } from '../../../db';
import { searchAndFetchFiles } from '../../vectorIndex';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import type { ToolDefinition, AgentFile, ToolResultBase } from './types';
import { formatBytes, getMimeTypeCategory } from '../utils';
import { splitKeywords } from '../../../lib/keywordSplitter';
import { createSuccessResponse, createErrorResponse } from './agentToolUtils';

export const definitions: ToolDefinition[] = [
  // 1. search_files — 主要搜索工具
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: `【智能搜索】理解用户意图并找到最相关的文件。
适用场景（几乎涵盖所有查找需求）：
• "找一下XX文件"、"我的XX在哪里"
• "找文档资料共享这个文件夹" → 自动拆分关键词智能匹配
• "上周修改的PPT"、"最近的照片"
• "包含'合同'的PDF"
• "大于10MB的视频"

💡 核心能力：
✓ 中文语义理解：自动识别"文档资料共享"等复合词
✓ 多维度匹配：文件名、内容、标签、描述
✓ 类型感知：自动区分图片/文档/视频等
✓ 时间范围：支持"最近N天"、"上周"、"本月"等自然语言`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（支持中文、英文、混合，如"项目报告2024"、"会议纪要"）' },
          limit: { type: 'number', description: '返回数量（默认10）' },
          mimeTypePrefix: { type: 'string', description: '按类型过滤：image/ | video/ | application/pdf | text/ 等' },
          folderId: { type: 'string', description: '限定在某个文件夹内搜索' },
          minSize: { type: 'number', description: '最小文件大小（字节），如 1024*1024=1MB' },
          maxSize: { type: 'number', description: '最大文件大小（字节）' },
          dateFrom: { type: 'string', description: '起始日期（ISO格式：2025-01-01）' },
          dateTo: { type: 'string', description: '截止日期（ISO格式：2025-12-31）' },
        },
        required: ['query'],
      },
    },
  },

  // 2. smart_search — 智能路由搜索
  {
    type: 'function',
    function: {
      name: 'smart_search',
      description: `【万能搜索】当不确定用哪个工具时，直接调用此工具即可。
它会自动判断最佳策略并返回结果。

适合场景：
• 用户需求模糊时："帮我找点东西"
• 需要综合多个条件时："找最近的PPT或Word"
• 快速试探性搜索

⚠️ 此工具会根据 query 内容自动选择最优搜索方式`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '用户的原始查询（保持原样传入）' },
          context: { type: 'string', description: '对话上下文（帮助理解意图）' },
          limit: { type: 'number', description: '返回数量（默认15）' },
        },
        required: ['query'],
      },
    },
  },

  // 3. filter_files — 高级筛选
  {
    type: 'function',
    function: {
      name: 'filter_files',
      description: `【高级筛选】按多个条件精确过滤文件列表。
适用场景：
• "找出所有超过100MB的文件"
• "本月创建的PDF文档"
• "未加标签的文件"
• "已分享的图片"

适合在已有大量结果后进一步精确筛选`,
      parameters: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: {
                  type: 'string',
                  enum: ['mimeType', 'size', 'created_at', 'updated_at', 'is_starred', 'has_tags'],
                  description: '字段名',
                },
                operator: {
                  type: 'string',
                  enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'is_null', 'not_null'],
                  description: '操作符',
                },
                value: { type: 'string', description: '值' },
              },
            },
            description: '筛选条件数组',
          },
          limit: { type: 'number', description: '返回数量（默认50）' },
          sortBy: { type: 'string', enum: ['name', 'size', 'updated_at', 'created_at'], description: '排序字段' },
          sortOrder: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
        },
      },
    },
  },

  // 4. search_by_tag — 标签搜索
  {
    type: 'function',
    function: {
      name: 'search_by_tag',
      description: `【标签搜索】通过标签快速定位相关文件。
适用场景：
• "所有标记为'重要'的文件"
• "带'工作'标签的文档"
• "有'待处理'标签的内容"

适合用户已经建立了良好标签体系的情况`,
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '目标标签名（支持模糊匹配）' },
          limit: { type: 'number', description: '返回数量（默认20）' },
        },
        required: ['tag'],
      },
    },
  },

  // 5. get_similar_files — 相似文件推荐
  {
    type: 'function',
    function: {
      name: 'get_similar_files',
      description: `【相似推荐】基于某个文件找到内容相似的其他文件。
适用场景：
• "找和这份报告类似的文档"
• "还有没有像这样的图片"
• "相关文件有哪些"

基于向量语义相似度计算，不仅看文件名还看内容`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '参考文件的ID' },
          limit: { type: 'number', description: '推荐数量（默认10）' },
        },
        required: ['fileId'],
      },
    },
  },

  // 6. get_file_details — 文件详情
  {
    type: 'function',
    function: {
      name: 'get_file_details',
      description: `【详细信息】获取文件的完整元数据和上下文信息。
适用场景：
• "这个文件的详细信息"
• "看看文件的属性"
• "什么时候上传的、多大"

比搜索结果返回更多信息：路径链、标签列表、分享状态等`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '目标文件ID' },
        },
        required: ['fileId'],
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

    // 使用智能关键词拆分（支持中文语义单元识别）
    const splitResult = splitKeywords(query);
    const keywords = splitResult.keywords.length > 0 ? splitResult.keywords : [query];

    logger.info('AgentTool', '搜索关键词智能拆分', {
      originalQuery: query,
      keywords,
      method: splitResult.method,
    });

    try {
      // 向量搜索使用原始查询（保持语义完整性）
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
      // FTS 回退搜索使用拆分后的关键词
      const conditions: any[] = [
        eq(files.userId, userId),
        isNull(files.deletedAt),
        or(
          ...keywords.flatMap((w) => [
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
          and(eq(files.userId, userId), isNull(files.deletedAt), inArray(files.id, [...intersection].slice(0, limit)))
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
      rows = await db.select().from(fileTags).where(eq(fileTags.userId, userId)).limit(limit).all();
    }

    return {
      total: rows.length,
      tags: rows.map((r) => ({
        name: r.name,
        color: r.color,
        usageCount: (r as any).usageCount || null,
        createdAt: r.createdAt,
      })),
      _next_actions: ['可使用 search_by_tag 按标签搜索文件', '可使用 add_tag / remove_tag 管理文件标签'],
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
