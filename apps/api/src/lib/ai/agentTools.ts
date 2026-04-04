/**
 * agentTools.ts
 * OSSshelf 文件管理智能体工具集
 *
 * 工具列表：
 *  1. search_files        — 语义/关键词混合搜索文件
 *  2. list_folder         — 列出某文件夹下的内容
 *  3. get_file_detail     — 获取单个文件详情（含 AI 摘要、标签、共享状态等）
 *  4. get_storage_stats   — 获取存储统计（总量、类型分布、最近上传）
 *  5. list_starred        — 列出收藏的文件
 *  6. list_shares         — 列出用户创建的共享链接
 *  7. list_recent         — 列出最近上传/修改的文件
 *  8. search_by_tag       — 按标签搜索文件
 */

import { eq, and, isNull, desc, like, or, inArray, sql, count } from 'drizzle-orm';
import { getDb, files, fileTags, shares, userStars, storageBuckets } from '../../db';
import { searchAndFetchFiles, buildFileTextForVector } from '../vectorIndex';
import type { Env } from '../../types/env';
import { logger } from '@osshelf/shared';

// ────────────────────────────────────────────────────────────
// Tool schema types (OpenAI-compatible function calling)
// ────────────────────────────────────────────────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  error?: string;
}

// ────────────────────────────────────────────────────────────
// Canonical file object returned by all tools (frontend uses this)
// ────────────────────────────────────────────────────────────

export interface AgentFile {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  mimeType: string | null;
  size: number;
  createdAt: string;
  updatedAt: string;
  parentId: string | null;
  aiSummary: string | null;
  aiTags: string | null;
  isStarred: boolean;
  description: string | null;
}

// ────────────────────────────────────────────────────────────
// Tool definitions (sent to LLM)
// ────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        '通过自然语言语义或关键词在用户的所有文件中搜索。适用于"帮我找关于XX的文件"、"有没有XX相关的文档"等场景。返回最相关的文件列表。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词或自然语言描述，例如："项目需求文档"、"2024年报告"、"logo图片"',
          },
          limit: {
            type: 'number',
            description: '返回结果数量，默认8，最大20',
          },
          mimeType: {
            type: 'string',
            description: '按文件类型过滤，例如："image/"、"application/pdf"、"text/"，不传则搜索所有类型',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_folder',
      description:
        '列出某个文件夹下的所有文件和子文件夹。适用于"查看XX文件夹里有什么"、"列出根目录下的内容"等场景。folderId为null时列出根目录。',
      parameters: {
        type: 'object',
        properties: {
          folderId: {
            type: 'string',
            description: '文件夹ID。传null或不传则列出根目录（顶层文件）',
          },
          limit: {
            type: 'number',
            description: '返回数量上限，默认30',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_detail',
      description:
        '获取某个文件或文件夹的完整详情，包括AI摘要、标签、共享状态、版本信息等。适用于用户想了解某具体文件的详情时。',
      parameters: {
        type: 'object',
        properties: {
          fileId: {
            type: 'string',
            description: '文件或文件夹的ID',
          },
        },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_storage_stats',
      description:
        '获取用户的存储统计数据，包括文件总数、总存储用量、各类型文件分布、最近上传记录等。适用于"我有多少文件"、"存储空间用了多少"等问题。',
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
      name: 'list_starred',
      description: '列出用户收藏（星标）的文件。适用于"我收藏了哪些文件"、"查看我的星标文件"等场景。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '返回数量，默认20',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_shares',
      description:
        '列出用户创建的文件共享链接，包括每个共享对应的文件、到期时间、下载次数等。适用于"我分享了哪些文件"、"查看共享链接"等场景。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '返回数量，默认20',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent',
      description: '列出最近上传或修改的文件，按时间倒序排列。适用于"最近上传了什么"、"最新的文件"等场景。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '返回数量，默认10',
          },
          type: {
            type: 'string',
            enum: ['uploaded', 'modified'],
            description: '排序依据：uploaded=按上传时间，modified=按修改时间，默认uploaded',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_by_tag',
      description: '按标签名搜索文件。适用于"查找标记为XX的文件"、"带有XX标签的文件"等场景。',
      parameters: {
        type: 'object',
        properties: {
          tagName: {
            type: 'string',
            description: '标签名称，支持模糊匹配',
          },
          limit: {
            type: 'number',
            description: '返回数量，默认20',
          },
        },
        required: ['tagName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_content',
      description:
        '获取文件的内容摘要和分段信息。适用于"这个PDF里第几页说了什么"、"这个文件讲了什么"、"文件的主要内容是什么"等场景。返回AI摘要、内容分段和元数据。',
      parameters: {
        type: 'object',
        properties: {
          fileId: {
            type: 'string',
            description: '文件的ID',
          },
          section: {
            type: 'string',
            description: '可选，指定查看的部分，如 "前半部分"、"关于XX的章节"、"结尾"。不传则返回完整摘要。',
          },
        },
        required: ['fileId'],
      },
    },
  },
];

// ────────────────────────────────────────────────────────────
// Tool executor
// ────────────────────────────────────────────────────────────

export class AgentToolExecutor {
  constructor(
    private env: Env,
    private userId: string
  ) {}

  async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    logger.info('AgentTool', `Executing tool: ${toolName}`, { args });

    switch (toolName) {
      case 'search_files':
        return this.searchFiles(args);
      case 'list_folder':
        return this.listFolder(args);
      case 'get_file_detail':
        return this.getFileDetail(args);
      case 'get_storage_stats':
        return this.getStorageStats();
      case 'list_starred':
        return this.listStarred(args);
      case 'list_shares':
        return this.listShares(args);
      case 'list_recent':
        return this.listRecent(args);
      case 'search_by_tag':
        return this.searchByTag(args);
      case 'get_file_content':
        return this.getFileContent(args);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Tool implementations ──────────────────────────────────

  private async searchFiles(args: Record<string, unknown>) {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 8, 20);
    const mimeTypeFilter = args.mimeType as string | undefined;

    const db = getDb(this.env.DB);

    // Try vector search first
    let results: AgentFile[] = [];
    try {
      const vectorResults = await searchAndFetchFiles(this.env, query, this.userId, {
        limit,
        threshold: 0.25,
      });
      results = vectorResults
        .filter((f) => !mimeTypeFilter || f.mimeType?.startsWith(mimeTypeFilter))
        .map(toAgentFile);
    } catch {
      // Vector search unavailable — fallback to FTS/LIKE
    }

    // Augment with keyword search if few vector results
    if (results.length < 3) {
      const kws = query
        .split(/\s+/)
        .slice(0, 3)
        .map((w) => `%${w}%`);
      const conditions = [
        eq(files.userId, this.userId),
        isNull(files.deletedAt),
        or(...kws.map((kw) => like(files.name, kw))),
      ].filter(Boolean);

      const kwResults = await db
        .select()
        .from(files)
        .where(and(...(conditions as any[])))
        .orderBy(desc(files.updatedAt))
        .limit(limit)
        .all();

      const existing = new Set(results.map((r) => r.id));
      const extra = kwResults
        .filter((f) => !existing.has(f.id))
        .filter((f) => !mimeTypeFilter || f.mimeType?.startsWith(mimeTypeFilter))
        .map(toAgentFile);

      results = [...results, ...extra].slice(0, limit);
    }

    return {
      total: results.length,
      files: results,
    };
  }

  private async listFolder(args: Record<string, unknown>) {
    const folderId = (args.folderId as string) || null;
    const limit = Math.min((args.limit as number) || 30, 100);
    const db = getDb(this.env.DB);

    const rows = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.userId, this.userId),
          isNull(files.deletedAt),
          folderId ? eq(files.parentId, folderId) : isNull(files.parentId)
        )
      )
      .orderBy(desc(files.isFolder), files.name)
      .limit(limit)
      .all();

    // If listing a folder, also get folder info
    let folderInfo: AgentFile | null = null;
    if (folderId) {
      const folder = await db
        .select()
        .from(files)
        .where(and(eq(files.id, folderId), eq(files.userId, this.userId)))
        .get();
      if (folder) folderInfo = toAgentFile(folder);
    }

    return {
      folderId: folderId || 'root',
      folderName: folderInfo?.name || '根目录',
      total: rows.length,
      files: rows.map(toAgentFile),
    };
  }

  private async getFileDetail(args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const db = getDb(this.env.DB);

    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, this.userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: '文件不存在或无权限访问' };

    // Get tags
    const tags = await db
      .select()
      .from(fileTags)
      .where(eq(fileTags.fileId, fileId))
      .all();

    // Get share info
    const shareInfo = await db
      .select()
      .from(shares)
      .where(eq(shares.fileId, fileId))
      .all();

    // If folder, get child count
    let childCount: number | null = null;
    if (file.isFolder) {
      const countRes = await db
        .select({ cnt: count(files.id) })
        .from(files)
        .where(and(eq(files.parentId, fileId), isNull(files.deletedAt)))
        .get();
      childCount = countRes?.cnt ?? 0;
    }

    return {
      ...toAgentFile(file),
      tags: tags.map((t) => ({ name: t.name, color: t.color })),
      shares: shareInfo.map((s) => ({
        id: s.id,
        expiresAt: s.expiresAt,
        downloadCount: s.downloadCount,
        downloadLimit: s.downloadLimit,
        isUploadLink: s.isUploadLink,
      })),
      childCount,
    };
  }

  private async getStorageStats() {
    const db = getDb(this.env.DB);

    const allFiles = await db
      .select({
        id: files.id,
        mimeType: files.mimeType,
        size: files.size,
        createdAt: files.createdAt,
        isFolder: files.isFolder,
        name: files.name,
      })
      .from(files)
      .where(and(eq(files.userId, this.userId), isNull(files.deletedAt), eq(files.isFolder, false)))
      .all();

    const totalFiles = allFiles.length;
    const totalSize = allFiles.reduce((s, f) => s + (f.size || 0), 0);

    // Group by type
    const typeMap = new Map<string, { count: number; size: number }>();
    for (const f of allFiles) {
      const cat = mimeCategory(f.mimeType);
      const cur = typeMap.get(cat) || { count: 0, size: 0 };
      typeMap.set(cat, { count: cur.count + 1, size: cur.size + (f.size || 0) });
    }
    const byType = Array.from(typeMap.entries())
      .map(([type, d]) => ({ type, count: d.count, size: d.size, sizeFormatted: formatBytes(d.size) }))
      .sort((a, b) => b.count - a.count);

    // Most recent 5
    const recent = allFiles
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((f) => ({ name: f.name, size: formatBytes(f.size || 0), createdAt: f.createdAt }));

    // Folder count
    const folderCountRes = await db
      .select({ cnt: count(files.id) })
      .from(files)
      .where(and(eq(files.userId, this.userId), isNull(files.deletedAt), eq(files.isFolder, true)))
      .get();

    return {
      totalFiles,
      totalFolders: folderCountRes?.cnt ?? 0,
      totalSize: formatBytes(totalSize),
      totalSizeBytes: totalSize,
      byType,
      recentUploads: recent,
    };
  }

  private async listStarred(args: Record<string, unknown>) {
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(this.env.DB);

    const starred = await db
      .select({ file: files, starredAt: userStars.createdAt })
      .from(userStars)
      .innerJoin(files, eq(userStars.fileId, files.id))
      .where(and(eq(userStars.userId, this.userId), isNull(files.deletedAt)))
      .orderBy(desc(userStars.createdAt))
      .limit(limit)
      .all();

    return {
      total: starred.length,
      files: starred.map((r) => ({ ...toAgentFile(r.file), starredAt: r.starredAt })),
    };
  }

  private async listShares(args: Record<string, unknown>) {
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(this.env.DB);

    const shareList = await db
      .select({ share: shares, file: files })
      .from(shares)
      .innerJoin(files, eq(shares.fileId, files.id))
      .where(eq(shares.userId, this.userId))
      .orderBy(desc(shares.createdAt))
      .limit(limit)
      .all();

    return {
      total: shareList.length,
      shares: shareList.map((r) => ({
        shareId: r.share.id,
        file: toAgentFile(r.file),
        expiresAt: r.share.expiresAt,
        downloadCount: r.share.downloadCount,
        downloadLimit: r.share.downloadLimit,
        isUploadLink: r.share.isUploadLink,
        createdAt: (r.share as any).createdAt,
      })),
    };
  }

  private async listRecent(args: Record<string, unknown>) {
    const limit = Math.min((args.limit as number) || 10, 50);
    const sortBy = (args.type as string) === 'modified' ? files.updatedAt : files.createdAt;
    const db = getDb(this.env.DB);

    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, this.userId), isNull(files.deletedAt), eq(files.isFolder, false)))
      .orderBy(desc(sortBy))
      .limit(limit)
      .all();

    return {
      total: rows.length,
      files: rows.map(toAgentFile),
    };
  }

  private async searchByTag(args: Record<string, unknown>) {
    const tagName = args.tagName as string;
    const limit = Math.min((args.limit as number) || 20, 50);
    const db = getDb(this.env.DB);

    const rows = await db
      .select({ file: files, tag: fileTags })
      .from(fileTags)
      .innerJoin(files, eq(fileTags.fileId, files.id))
      .where(
        and(
          eq(fileTags.userId, this.userId),
          like(fileTags.name, `%${tagName}%`),
          isNull(files.deletedAt)
        )
      )
      .orderBy(desc(files.updatedAt))
      .limit(limit)
      .all();

    return {
      tagQuery: tagName,
      total: rows.length,
      files: rows.map((r) => ({ ...toAgentFile(r.file), matchedTag: r.tag.name })),
    };
  }

  private async getFileContent(args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const section = args.section as string | undefined;
    const db = getDb(this.env.DB);

    const file = await db.select().from(files).where(and(eq(files.id, fileId), eq(files.userId, this.userId))).get();

    if (!file) {
      throw new Error(`文件不存在或无权访问: ${fileId}`);
    }

    const vectorText = await buildFileTextForVector(this.env, fileId);
    const sections: Array<{ title: string; content: string }> = [];

    if (vectorText && vectorText.length > 100) {
      const chunkSize = 1500;
      if (vectorText.length <= chunkSize) {
        sections.push({ title: '完整内容', content: vectorText });
      } else {
        const totalChunks = Math.ceil(vectorText.length / chunkSize);
        for (let i = 0; i < totalChunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, vectorText.length);
          sections.push({ title: `第 ${i + 1} 段（共 ${totalChunks} 段）`, content: vectorText.slice(start, end) });
        }
      }

      if (section) {
        const matchedSection = sections.find((s) => s.title.includes(section)) || sections[0];
        return {
          fileId,
          fileName: file.name,
          mimeType: file.mimeType,
          aiSummary: file.aiSummary || '暂无AI摘要',
          section: matchedSection?.title || '',
          content: matchedSection?.content || '',
          totalSections: sections.length,
          hasMore: sections.length > 1,
        };
      }

      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        aiSummary: file.aiSummary || '暂无AI摘要',
        sections: sections.slice(0, 5),
        totalSections: sections.length,
        hasMore: sections.length > 5,
      };
    }

    return {
      fileId,
      fileName: file.name,
      mimeType: file.mimeType,
      aiSummary: file.aiSummary || '暂无AI摘要',
      sections: [],
      totalSections: 0,
      note: '该文件无文本内容可供读取（可能是二进制/图片文件）',
    };
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function toAgentFile(f: Record<string, unknown>): AgentFile {
  return {
    id: f.id as string,
    name: f.name as string,
    path: f.path as string,
    isFolder: Boolean(f.isFolder),
    mimeType: (f.mimeType as string) || null,
    size: (f.size as number) || 0,
    createdAt: f.createdAt as string,
    updatedAt: f.updatedAt as string,
    parentId: (f.parentId as string) || null,
    aiSummary: (f.aiSummary as string) || null,
    aiTags: (f.aiTags as string) || null,
    isStarred: Boolean(f.isStarred),
    description: (f.description as string) || null,
  };
}

function mimeCategory(mime: string | null): string {
  if (!mime) return '其他';
  if (mime.startsWith('image/')) return '图片';
  if (mime.startsWith('video/')) return '视频';
  if (mime.startsWith('audio/')) return '音频';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('word') || mime.includes('document')) return 'Word文档';
  if (mime.includes('excel') || mime.includes('spreadsheet')) return '表格';
  if (mime.includes('powerpoint') || mime.includes('presentation')) return '演示文稿';
  if (mime.startsWith('text/')) return '文本';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return '压缩包';
  if (mime.includes('json') || mime.includes('xml')) return '数据文件';
  return '其他';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
