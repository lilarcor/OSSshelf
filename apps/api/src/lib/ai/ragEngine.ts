/**
 * ragEngine.ts
 * RAG (检索增强生成) 引擎
 *
 * 功能:
 * - 智能上下文组装
 * - Prompt模板管理
 * - 文件内容检索与优化
 * - 来源引用管理
 */

import type { Env } from '../../types/env';
import { searchAndFetchFiles, buildFileTextForVector } from '../vectorIndex';
import { getDb, files } from '../../db';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { logger } from '@osshelf/shared';

export interface FileContext {
  id: string;
  name: string;
  mimeType: string | null;
  similarityScore: number;
  summary?: string;
  description?: string;
  content?: string;
}

export interface RagContext {
  query: string;
  relevantFiles: FileContext[];
  assembledPrompt: string;
  totalTokens: number;
  timestamp: string;
}

export interface ChatRagRequest {
  query: string;
  userId: string;
  maxFiles?: number;
  maxContextLength?: number;
  includeFileContent?: boolean;
  conversationHistory?: Array<{ role: string; content: string }>;
}

const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_CONTEXT_LENGTH = 8000;
const ESTIMATED_TOKENS_PER_CHAR = 0.5;

const FILE_LIST_PATTERNS = [
  /我有(多少|哪些|什么)文件/,
  /文件(列表|清单|目录)/,
  /(列出|显示|查看)(所有|全部)?文件/,
  /最近(上传|添加|修改)的文件/,
  /文件统计/,
  /(多少个|几个)文件/,
  /存储(情况|空间|使用)/,
  /文件(总数|数量|个数)/,
  /总共.*文件/,
  /全部.*文件/,
  /所有.*文件/,
];

const SYSTEM_PROMPTS = {
  default: `你是OSSshelf文件管理系统的智能助手。你的职责是帮助用户查询、分析和管理他们的文件。

核心能力：
1. 文件搜索和定位：根据用户描述找到相关文件
2. 内容摘要和分析：总结文件主要内容，提取关键信息
3. 智能问答：基于文件内容回答用户问题
4. 文件统计：回答关于文件数量、类型分布等问题

回答规则：
- 基于提供的文件信息回答问题，不要编造信息
- 如果文件信息不足以回答问题，请如实说明
- 在回答末尾用"来源：[序号]"注明引用了哪些文件（如果有）
- 回答要简洁准确，使用中文（除非用户使用其他语言）
- 对于技术文档，可以适当使用代码块展示关键内容`,

  file_expert: `你是文件分析专家。你擅长：
- 分析文档结构和内容
- 提取关键信息和数据
- 对比多个文件的异同
- 生成详细的文件报告

请根据提供的文件信息，给出专业、详细的分析。`,

  code_assistant: `你是编程助手。你擅长：
- 理释代码逻辑和功能
- 识别潜在问题和优化点
- 解释API接口和数据结构
- 提供代码改进建议

请基于代码文件给出专业的技术分析和建议。`,
};

export class RagEngine {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  private isFileListQuery(query: string): boolean {
    return FILE_LIST_PATTERNS.some((pattern) => pattern.test(query));
  }

  async getFileStats(userId: string): Promise<{
    totalFiles: number;
    totalSize: number;
    byType: Array<{ type: string; count: number; size: number }>;
    recentFiles: Array<{ name: string; mimeType: string | null; size: number; createdAt: string }>;
  }> {
    const db = getDb(this.env.DB);

    const allFiles = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.isFolder, false)))
      .all();

    const totalFiles = allFiles.length;
    const totalSize = allFiles.reduce((sum, f) => sum + (f.size || 0), 0);

    const typeMap = new Map<string, { count: number; size: number }>();
    for (const file of allFiles) {
      const type = this.getFileTypeCategory(file.mimeType);
      const existing = typeMap.get(type) || { count: 0, size: 0 };
      typeMap.set(type, {
        count: existing.count + 1,
        size: existing.size + (file.size || 0),
      });
    }

    const byType = Array.from(typeMap.entries())
      .map(([type, data]) => ({ type, count: data.count, size: data.size }))
      .sort((a, b) => b.count - a.count);

    const recentFiles = allFiles
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10)
      .map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        size: f.size || 0,
        createdAt: f.createdAt,
      }));

    return { totalFiles, totalSize, byType, recentFiles };
  }

  private getFileTypeCategory(mimeType: string | null): string {
    if (!mimeType) return '其他';
    if (mimeType.startsWith('image/')) return '图片';
    if (mimeType.startsWith('video/')) return '视频';
    if (mimeType.startsWith('audio/')) return '音频';
    if (mimeType.includes('pdf')) return 'PDF';
    if (mimeType.includes('word') || mimeType.includes('document')) return '文档';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '表格';
    if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return '演示文稿';
    if (mimeType.startsWith('text/')) return '文本';
    if (mimeType.includes('json') || mimeType.includes('xml')) return '数据文件';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return '压缩包';
    return '其他';
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async buildContext(request: ChatRagRequest): Promise<RagContext> {
    const startTime = Date.now();

    try {
      const isFileList = this.isFileListQuery(request.query);
      let relevantFiles: FileContext[] = [];
      let statsContext = '';

      if (isFileList) {
        const stats = await this.getFileStats(request.userId);
        statsContext = this.formatStatsContext(stats);

        const db = getDb(this.env.DB);
        const recentFiles = await db
          .select()
          .from(files)
          .where(and(eq(files.userId, request.userId), isNull(files.deletedAt), eq(files.isFolder, false)))
          .orderBy(desc(files.createdAt))
          .limit(request.maxFiles || 10)
          .all();

        relevantFiles = recentFiles.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          similarityScore: 1.0,
          summary: f.aiSummary || undefined,
          description: f.description || undefined,
        }));
      } else {
        relevantFiles = await this.searchRelevantFiles(
          request.query,
          request.userId,
          request.maxFiles || DEFAULT_MAX_FILES
        );

        if (relevantFiles.length === 0) {
          const db = getDb(this.env.DB);
          const fallbackFiles = await db
            .select()
            .from(files)
            .where(and(eq(files.userId, request.userId), isNull(files.deletedAt), eq(files.isFolder, false)))
            .orderBy(desc(files.updatedAt))
            .limit(5)
            .all();

          relevantFiles = fallbackFiles.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            similarityScore: 0.1,
            summary: f.aiSummary || undefined,
            description: f.description || undefined,
          }));
        }
      }

      if (relevantFiles.length === 0 && !statsContext) {
        return {
          query: request.query,
          relevantFiles: [],
          assembledPrompt: this.buildEmptyResponsePrompt(request.query),
          totalTokens: 0,
          timestamp: new Date().toISOString(),
        };
      }

      const contextText = await this.assembleFileContext(
        relevantFiles,
        request.includeFileContent ?? false,
        request.maxContextLength || DEFAULT_MAX_CONTEXT_LENGTH
      );

      const conversationContext = this.formatConversationHistory(request.conversationHistory || []);

      const assembledPrompt = this.assembleFinalPrompt({
        systemPrompt: SYSTEM_PROMPTS.default,
        userQuery: request.query,
        contextText: statsContext ? `${statsContext}\n\n${contextText}` : contextText,
        conversationContext,
        hasStatsContext: !!statsContext,
      });

      const totalTokens = Math.ceil(assembledPrompt.length * ESTIMATED_TOKENS_PER_CHAR);

      logger.info('RAG', 'Context built', {
        query: request.query.slice(0, 50),
        fileCount: relevantFiles.length,
        contextLength: contextText.length,
        totalTimeMs: Date.now() - startTime,
        isFileListQuery: isFileList,
      });

      return {
        query: request.query,
        relevantFiles,
        assembledPrompt,
        totalTokens,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('RAG', 'Failed to build context', { query: request.query }, error);
      throw error;
    }
  }

  private formatStatsContext(stats: {
    totalFiles: number;
    totalSize: number;
    byType: Array<{ type: string; count: number; size: number }>;
    recentFiles: Array<{ name: string; mimeType: string | null; size: number; createdAt: string }>;
  }): string {
    const parts: string[] = ['=== 用户文件统计信息 ==='];

    parts.push(`总文件数：${stats.totalFiles} 个`);
    parts.push(`总存储空间：${this.formatFileSize(stats.totalSize)}`);

    if (stats.byType.length > 0) {
      parts.push('\n按类型分布：');
      for (const item of stats.byType.slice(0, 8)) {
        parts.push(`- ${item.type}：${item.count} 个，${this.formatFileSize(item.size)}`);
      }
    }

    if (stats.recentFiles.length > 0) {
      parts.push('\n最近添加的文件：');
      for (const file of stats.recentFiles.slice(0, 5)) {
        const date = new Date(file.createdAt).toLocaleDateString('zh-CN');
        parts.push(`- ${file.name} (${this.formatFileSize(file.size)}, ${date})`);
      }
    }

    parts.push('=== 统计信息结束 ===\n');
    return parts.join('\n');
  }

  async searchRelevantFiles(query: string, userId: string, limit: number = DEFAULT_MAX_FILES): Promise<FileContext[]> {
    try {
      const searchResults = await searchAndFetchFiles(this.env, query, userId, {
        limit,
        threshold: 0.3,
      });

      return searchResults.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        similarityScore: file.similarityScore,
        summary: file.aiSummary || undefined,
        description: file.description || undefined,
      }));
    } catch (error) {
      logger.error('RAG', 'File search failed', { query, userId }, error);
      return [];
    }
  }

  private async assembleFileContext(files: FileContext[], includeContent: boolean, maxLength: number): Promise<string> {
    const parts: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileParts: string[] = [`[${i + 1}] 文件名：${file.name}`];

      if (file.mimeType) {
        fileParts.push(`类型：${file.mimeType}`);
      }

      fileParts.push(`相关度：${(file.similarityScore * 100).toFixed(1)}%`);

      if (file.summary) {
        fileParts.push(`摘要：${file.summary}`);
      }

      if (file.description) {
        fileParts.push(`描述：${file.description}`);
      }

      if (includeContent) {
        try {
          const content = await buildFileTextForVector(this.env, file.id);
          if (content && content.length > 0) {
            const truncatedContent = content.slice(0, 1000);
            fileParts.push(`内容预览：\n${truncatedContent}`);
          }
        } catch {
          continue;
        }
      }

      const fileText = fileParts.join('\n');

      if (currentLength + fileText.length > maxLength) {
        break;
      }

      parts.push(fileText);
      currentLength += fileText.length;
    }

    return parts.join('\n\n');
  }

  private formatConversationHistory(history: Array<{ role: string; content: string }>): string {
    if (history.length === 0) {
      return '';
    }

    const recentHistory = history.slice(-6);
    const formatted = recentHistory
      .map((msg) => {
        const role = msg.role === 'user' ? '用户' : '助手';
        return `${role}：${msg.content}`;
      })
      .join('\n');

    return `\n\n=== 历史对话 ===\n${formatted}\n=== 历史对话结束 ===\n`;
  }

  private assembleFinalPrompt(params: {
    systemPrompt: string;
    userQuery: string;
    contextText: string;
    conversationContext: string;
    hasStatsContext?: boolean;
  }): string {
    const { systemPrompt, userQuery, contextText, conversationContext, hasStatsContext } = params;

    const statsGuidance = hasStatsContext
      ? `\n重要提示：用户询问的是文件统计信息，请优先根据上方的"用户文件统计信息"部分回答，那里包含了准确的文件总数、类型分布等统计数据。不要根据下方列出的示例文件数量来回答统计问题。`
      : '';

    return `${systemPrompt}
${conversationContext}
== 相关文件信息 ==
${contextText}
== 文件信息结束 ==
${statsGuidance}

请根据以上文件信息回答用户的问题。

用户问题：${userQuery}`;
  }

  private buildEmptyResponsePrompt(query: string): string {
    return `${SYSTEM_PROMPTS.default}

用户问题：${query}

注意：当前未找到与此问题相关的文件。如果这是一个关于文件管理的通用问题，你可以根据你的知识回答；如果是特定文件内容的询问，请告知用户需要先上传或索引相关文件。`;
  }

  formatSourcesForResponse(files: FileContext[]): string {
    if (files.length === 0) {
      return '';
    }

    return (
      '\n\n---\n**参考来源：**\n' +
      files.map((f, i) => `${i + 1}. **${f.name}** (相关度: ${(f.similarityScore * 100).toFixed(0)}%)`).join('\n')
    );
  }

  getSystemPrompt(type: keyof typeof SYSTEM_PROMPTS = 'default'): string {
    return SYSTEM_PROMPTS[type] || SYSTEM_PROMPTS.default;
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}
