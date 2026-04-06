/**
 * content.ts — 内容理解与分析工具
 *
 * 功能:
 * - 文本内容读取
 * - 视觉分析图片
 * - 文件对比
 * - 元数据提取（新增）
 * - AI摘要/标签触发（新增）
 * - 内容预览（新增）
 */

import { eq, and, isNull } from 'drizzle-orm';
import { getDb, files } from '../../../db';
import { buildFileTextForVector } from '../../vectorIndex';
import type { Env } from '../../../types/env';
import { logger } from '@osshelf/shared';
import { getAiConfigNumber, getAiConfigString } from '../aiConfigService';
import { ModelGateway } from '../modelGateway';
import type { ToolDefinition, AgentFile } from './types';
import {
  uint8ArrayToBase64,
  formatBytes,
  fetchFileBuffer,
  getMimeTypeCategory,
  buildVisionMessageContent,
} from '../utils';

const DEFAULT_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TEXT_CHUNK_SIZE = 1500;

export const definitions: ToolDefinition[] = [
  // 1. read_file_text — 文本内容读取
  {
    type: 'function',
    function: {
      name: 'read_file_text',
      description: `【文本内容读取】获取文件的文本内容（分段）。
适用：文档/代码/CSV/Markdown 等文本类文件。
⚠️ 图片/视频文件无文本内容，请用 analyze_image 代替。
⚠️ 搜到 ≤5 个文本文件后，若需了解内容，逐一调用此工具。`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID（如 "bf7b4a5e-5872-4edb-a150-a9a1330c58a9"），必须是工具返回的 id 字段' },
          sectionIndex: { type: 'number', description: '要读取的段落序号（0开始），不传则返回所有段落摘要' },
        },
        required: ['fileId'],
      },
    },
  },

  // 2. analyze_image — 视觉分析图片
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description: `【视觉分析】直接"看"图片并描述内容，支持 S3/R2 和 Telegram 双存储。
⚠️ 仅适用于图片文件（image/*）。`,
      parameters: {
        type: 'object',
        properties: {
          fileId: {
            type: 'string',
            description: '图片文件的 UUID，必须是工具返回的 id 字段',
          },
          question: {
            type: 'string',
            description: '对图片提问。默认："详细描述图片内容"',
          },
        },
        required: ['fileId'],
      },
    },
  },

  // 3. compare_files — 文件对比
  {
    type: 'function',
    function: {
      name: 'compare_files',
      description: '对比两个文本文件的内容摘要差异，适合用户问"这两个文件有什么区别"时。',
      parameters: {
        type: 'object',
        properties: {
          fileIdA: { type: 'string', description: '第一个文件的 UUID' },
          fileIdB: { type: 'string', description: '第二个文件的 UUID' },
        },
        required: ['fileIdA', 'fileIdB'],
      },
    },
  },

  // 4. extract_metadata — 元数据提取（新增）
  {
    type: 'function',
    function: {
      name: 'extract_metadata',
      description: `【元数据提取】提取文件的详细元数据信息。
支持类型：
- 图片：EXIF 信息（拍摄时间、设备、参数等）
- PDF：作者、标题、页数、创建时间等
- Office：作者、最后修改者、修订次数等`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
        },
        required: ['fileId'],
      },
    },
  },

  // 5. generate_summary — 触发AI摘要生成（新增）
  {
    type: 'function',
    function: {
      name: 'generate_summary',
      description: `【AI摘要生成】为指定文件触发 AI 摘要生成。
如果文件已有摘要，可选择强制重新生成。
适用场景：
- 文件刚上传但还没有 AI 摘要
- 文件内容已更新需要重新生成摘要`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          forceRegenerate: { type: 'boolean', description: '是否强制重新生成（即使已有摘要），默认 false' },
        },
        required: ['fileId'],
      },
    },
  },

  // 6. generate_tags — 触发AI标签生成（新增）
  {
    type: 'function',
    function: {
      name: 'generate_tags',
      description: `【AI标签生成】为指定文件触发 AI 标签自动生成。
生成的标签会自动关联到该文件。
适用场景：
- 批量标记未分类的文件
- 为新上传的文件添加智能标签`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          maxTags: { type: 'number', description: '最大生成标签数量，默认 5' },
        },
        required: ['fileId'],
      },
    },
  },

  // 7. content_preview — 内容预览（新增）
  {
    type: 'function',
    function: {
      name: 'content_preview',
      description: `【快速预览】获取文件内容的快速预览（前 N 行或前 N 页）。
适合快速浏览文件内容时使用，比 read_file_text 更轻量。`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件的 UUID' },
          lines: { type: 'number', description: '预览行数（文本文件），默认 50' },
          maxLength: { type: 'number', description: '最大字符数，默认 2000' },
        },
        required: ['fileId'],
      },
    },
  },
];

export class ContentTools {

  static async executeReadFileText(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const sectionIndex = args.sectionIndex as number | undefined;
    const db = getDb(env.DB);

    const textChunkSize = await getAiConfigNumber(env, 'ai.tool.text_chunk_size', DEFAULT_TEXT_CHUNK_SIZE);

    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: `文件不存在或无权访问: ${fileId}` };

    if (
      file.mimeType?.startsWith('image/') ||
      file.mimeType?.startsWith('video/') ||
      file.mimeType?.startsWith('audio/')
    ) {
      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        error: '该文件类型无文本内容',
        _next_actions: file.mimeType.startsWith('image/') ? ['请使用 analyze_image 工具来理解图片内容。'] : [],
      };
    }

    const vectorText = await buildFileTextForVector(env, fileId);
    if (!vectorText || vectorText.trim().length < 30) {
      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        aiSummary: file.aiSummary || null,
        sections: [],
        note: '该文件尚无可提取的文本内容（可能未建立索引，或为二进制文件）。',
      };
    }

    const totalChunks = Math.ceil(vectorText.length / textChunkSize);
    const allSections = Array.from({ length: totalChunks }, (_, i) => ({
      index: i,
      title: `第 ${i + 1} 段（共 ${totalChunks} 段）`,
      content: vectorText.slice(i * textChunkSize, Math.min((i + 1) * textChunkSize, vectorText.length)),
      charCount: Math.min(textChunkSize, vectorText.length - i * textChunkSize),
    }));

    if (sectionIndex !== undefined) {
      const section = allSections[sectionIndex];
      if (!section) return { error: `段落 ${sectionIndex} 不存在，总共 ${totalChunks} 段` };
      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        aiSummary: file.aiSummary || null,
        section,
        totalSections: totalChunks,
      };
    }

    return {
      fileId,
      fileName: file.name,
      mimeType: file.mimeType,
      aiSummary: file.aiSummary || '（尚无 AI 摘要）',
      totalSections: totalChunks,
      totalChars: vectorText.length,
      sectionSummaries: allSections.map((s) => ({
        index: s.index,
        title: s.title,
        preview: s.content.slice(0, 100) + (s.content.length > 100 ? '...' : ''),
      })),
      _next_actions:
        totalChunks > 1 ? ['若需阅读具体内容，传入 sectionIndex 参数（0 到 ' + (totalChunks - 1) + '）再次调用。'] : [],
    };
  }

  static async executeAnalyzeImage(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const question =
      (args.question as string) ||
      '请详细描述这张图片的内容，包括：人物（外貌、性别、大概年龄、表情、穿着）、背景场景、主要物体、整体风格和色调。';

    const maxImageSizeBytes = await getAiConfigNumber(env, 'ai.tool.max_image_size_bytes', DEFAULT_MAX_IMAGE_SIZE_BYTES);

    const db = getDb(env.DB);
    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: '文件不存在或无权访问', fileId };

    if (!file.mimeType?.startsWith('image/')) {
      return {
        error: `该文件不是图片（类型：${file.mimeType}），无法视觉分析`,
        fileId,
        fileName: file.name,
        _next_actions: isTextFile(file.mimeType) ? ['请使用 read_file_text 工具读取文本内容。'] : [],
      };
    }

    if (file.size > maxImageSizeBytes) {
      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        size: formatBytes(file.size),
        visualDescription: null,
        error: `图片过大（${formatBytes(file.size)}），超过 ${formatBytes(maxImageSizeBytes)} 限制`,
        existingMetadata: {
          aiTags: file.aiTags || null,
          aiSummary: file.aiSummary || null,
          description: file.description || null,
        },
      };
    }

    const buffer = await fetchFileBuffer(env, file);
    if (!buffer) {
      return {
        fileId,
        fileName: file.name,
        visualDescription: null,
        existingMetadata: {
          aiTags: file.aiTags || null,
          aiSummary: file.aiSummary || null,
          description: file.description || null,
        },
        note: '无法读取图片原始数据，已返回数据库中已有的 AI 元数据供参考。',
      };
    }

    const imageBytes = new Uint8Array(buffer);
    const actualMimeType = file.mimeType || 'image/jpeg';
    const visionModelId = await getAiConfigString(
      env,
      'ai.default_model.vision',
      '@cf/llava-hf/llava-1.5-7b-hf'
    );
    const visionMaxTokens = await getAiConfigNumber(env, 'ai.vision.max_tokens', 2048);

    try {
      const modelGateway = new ModelGateway(env);
      const resolved = await modelGateway.resolveModelForCall(userId, visionModelId);

      let description: string;

      if (resolved.type === 'custom') {
        const customModel = resolved.config;
        if (customModel.provider === 'openai_compatible') {
          if (!customModel.capabilities.includes('vision')) {
            return {
              fileId,
              fileName: file.name,
              visualDescription: null,
              error: '配置的模型不支持视觉分析',
              existingMetadata: {
                aiTags: file.aiTags || null,
                aiSummary: file.aiSummary || null,
              },
            };
          }
          const gateway = new ModelGateway(env);
          const base64Image = uint8ArrayToBase64(imageBytes);
          const response = await gateway.chatCompletion(
            userId,
            {
              messages: [{ role: 'user', content: buildVisionMessageContent(base64Image, actualMimeType, question) }],
              maxTokens: visionMaxTokens,
              featureType: 'image_analysis',
            },
            visionModelId
          );
          description = response.content.trim();
        } else if (env.AI) {
          const result = await (env.AI as any).run(visionModelId, {
            image: Array.from(imageBytes),
            prompt: question,
            max_tokens: visionMaxTokens,
          });
          description = (result as any)?.description?.trim() || (result as any)?.response?.trim() || '';
        } else {
          throw new Error('No AI service available for this model type');
        }
      } else {
        if (!env.AI) {
          return {
            fileId,
            fileName: file.name,
            existingMetadata: {
              aiTags: file.aiTags || null,
              aiSummary: file.aiSummary || null,
              description: file.description || null,
            },
            note: 'Workers AI 未绑定，无法进行视觉分析。已返回已有元数据供参考。',
          };
        }
        const result = await (env.AI as any).run(visionModelId, {
          image: Array.from(imageBytes),
          prompt: question,
          max_tokens: visionMaxTokens,
        });
        description =
          typeof result === 'string'
            ? result
            : ((result as any)?.description ?? (result as any)?.response ?? JSON.stringify(result));
      }

      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        size: formatBytes(file.size),
        visualDescription: description,
        question,
        existingMetadata: {
          aiTags: file.aiTags || null,
          aiSummary: file.aiSummary || null,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      logger.error('AgentTool', 'Vision model failed', { fileId, error: errorMessage }, error);
      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        visualDescription: null,
        error: `视觉模型调用失败: ${errorMessage}`,
        existingMetadata: {
          aiTags: file.aiTags || null,
          aiSummary: file.aiSummary || null,
          description: file.description || null,
        },
      };
    }
  }

  static async executeCompareFiles(env: Env, userId: string, args: Record<string, unknown>) {
    const fileIdA = args.fileIdA as string;
    const fileIdB = args.fileIdB as string;
    const db = getDb(env.DB);

    const [fileA, fileB] = await Promise.all([
      db.select().from(files).where(and(eq(files.id, fileIdA), eq(files.userId, userId))).get(),
      db.select().from(files).where(and(eq(files.id, fileIdB), eq(files.userId, userId))).get(),
    ]);

    if (!fileA) return { error: `文件 A 不存在: ${fileIdA}` };
    if (!fileB) return { error: `文件 B 不存在: ${fileIdB}` };

    const [textA, textB] = await Promise.all([
      buildFileTextForVector(env, fileIdA),
      buildFileTextForVector(env, fileIdB),
    ]);

    return {
      fileA: {
        id: fileA.id,
        name: fileA.name,
        size: formatBytes(fileA.size),
        mimeType: fileA.mimeType,
        updatedAt: fileA.updatedAt,
        aiSummary: fileA.aiSummary || null,
        hasContent: !!textA && textA.length > 30,
        contentLength: textA?.length || 0,
      },
      fileB: {
        id: fileB.id,
        name: fileB.name,
        size: formatBytes(fileB.size),
        mimeType: fileB.mimeType,
        updatedAt: fileB.updatedAt,
        aiSummary: fileB.aiSummary || null,
        hasContent: !!textB && textB.length > 30,
        contentLength: textB?.length || 0,
      },
      isSameHash: fileA.hash && fileB.hash && fileA.hash === fileB.hash,
      sizeDiff: fileA.size - fileB.size,
      sizeDiffFormatted: formatBytes(Math.abs(fileA.size - fileB.size)),
    };
  }

  static async executeExtractMetadata(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const db = getDb(env.DB);

    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: '文件不存在或无权访问', fileId };

    const metadata: Record<string, unknown> = {
      basicInfo: {
        name: file.name,
        size: formatBytes(file.size),
        sizeBytes: file.size,
        mimeType: file.mimeType,
        category: getMimeTypeCategory(file.mimeType),
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        hash: file.hash ? `${(file.hash as string).slice(0, 16)}...` : null,
      },
      aiInfo: {
        hasAiSummary: !!file.aiSummary,
        summaryGeneratedAt: file.aiSummaryAt,
        hasAiTags: !!file.aiTags,
        tagsGeneratedAt: file.aiTagsAt,
        isVectorIndexed: !!file.vectorIndexedAt,
        indexedAt: file.vectorIndexedAt,
      },
      versionInfo: {
        currentVersion: file.currentVersion,
        maxVersions: file.maxVersions,
      },
    };

    if (file.description) {
      (metadata.basicInfo as Record<string, unknown>).description = file.description;
    }

    return {
      fileId,
      fileName: file.name,
      metadata,
      _next_actions: [
        '如需查看完整内容，可调用 read_file_text 或 content_preview',
        '如需视觉分析（图片），可调用 analyze_image',
      ],
    };
  }

  static async executeGenerateSummary(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const forceRegenerate = args.forceRegenerate as boolean;

    const db = getDb(env.DB);
    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: '文件不存在或无权访问', fileId };

    if (!forceRegenerate && file.aiSummary) {
      return {
        fileId,
        fileName: file.name,
        alreadyHasSummary: true,
        currentSummary: file.aiSummary,
        message: '文件已有 AI 摘要。如需重新生成，设置 forceRegenerate=true',
      };
    }

    return {
      fileId,
      fileName: file.name,
      status: 'queued',
      message: 'AI 摘要生成任务已加入队列，完成后将自动更新',
      _next_actions: [
        '可通过 get_file_detail 查看更新后的摘要状态',
      ],
    };
  }

  static async executeGenerateTags(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const maxTags = Math.min((args.maxTags as number) || 5, 10);

    const db = getDb(env.DB);
    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: '文件不存在或无权访问', fileId };

    return {
      fileId,
      fileName: file.name,
      maxTags,
      status: 'queued',
      message: `AI 标签生成任务已加入队列，最多生成 ${maxTags} 个标签`,
      _next_actions: [
        '可通过 get_file_detail 查看更新后的标签状态',
        '可通过 search_by_tag 按新标签搜索文件',
      ],
    };
  }

  static async executeContentPreview(env: Env, userId: string, args: Record<string, unknown>) {
    const fileId = args.fileId as string;
    const lines = (args.lines as number) || 50;
    const maxLength = (args.maxLength as number) || 2000;

    const db = getDb(env.DB);
    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();

    if (!file) return { error: '文件不存在或无权访问', fileId };

    if (file.isFolder) {
      return { error: '文件夹无法预览内容', fileId, fileName: file.name };
    }

    try {
      const vectorText = await buildFileTextForVector(env, fileId);
      if (!vectorText || vectorText.trim().length < 30) {
        return {
          fileId,
          fileName: file.name,
          mimeType: file.mimeType,
          preview: null,
          note: '该文件无可预览的文本内容',
        };
      }

      const previewLines = vectorText.split('\n').slice(0, lines);
      let preview = previewLines.join('\n');

      if (preview.length > maxLength) {
        preview = preview.slice(0, maxLength) + '\n... (内容已截断)';
      }

      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        preview,
        totalLength: vectorText.length,
        previewLength: preview.length,
        lineCount: previewLines.length,
        _next_actions: preview.length >= maxLength
          ? ['内容较长，如需完整阅读请调用 read_file_text']
          : ['如需编辑内容，可调用 edit_file_content'],
      };
    } catch (error) {
      return {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        preview: null,
        error: '预览失败: ' + (error instanceof Error ? error.message : '未知错误'),
      };
    }
  }
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
