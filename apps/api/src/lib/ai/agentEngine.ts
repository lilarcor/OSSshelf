/**
 * agentEngine.ts
 * OSSshelf 文件管理智能体引擎
 *
 * 实现 ReAct 循环（Reason → Act → Observe → Repeat）
 *
 * 关键设计：
 * - 通过 system prompt 引导 LLM 输出 JSON tool_call（兼容不支持 native tool_use 的模型）
 * - 最多 5 轮 tool 调用防止死循环
 * - 每次 tool 执行后立即 emit SSE 状态更新，前端可渲染进度
 * - 最终 assistant 消息含有结构化的 files 数据供前端渲染可点击卡片
 */

import type { Env } from '../../types/env';
import { ModelGateway } from './modelGateway';
import { AgentToolExecutor, TOOL_DEFINITIONS, type ToolCall, type ToolResult } from './agentTools';
import { logger } from '@osshelf/shared';

// ────────────────────────────────────────────────────────────
// SSE chunk types
// ────────────────────────────────────────────────────────────

export type AgentChunk =
  | { type: 'text'; content: string; done: false }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown>; done: false }
  | { type: 'tool_result'; toolCallId: string; toolName: string; result: unknown; done: false }
  | { type: 'done'; sessionId: string; sources: AgentSource[]; done: true }
  | { type: 'error'; message: string; done: true };

export interface AgentSource {
  id: string;
  name: string;
  mimeType: string | null;
  score: number;
}

// ────────────────────────────────────────────────────────────
// System prompt — OSSshelf 专属
// ────────────────────────────────────────────────────────────

export const AGENT_SYSTEM_PROMPT = `你是 OSSshelf 的文件管理智能助手。OSSshelf 是一个私有云文件管理系统，支持多云存储（R2/S3/OSS/COS/B2/MinIO）、文件共享、AI 智能索引等功能。

## 你的能力

你可以调用以下工具直接查询用户的文件系统数据库：
- **search_files**: 语义/关键词混合搜索文件
- **list_folder**: 列出文件夹内容
- **get_file_detail**: 获取文件详情（含AI摘要、标签、共享状态）
- **get_storage_stats**: 获取存储统计
- **list_starred**: 查看收藏文件
- **list_shares**: 查看共享链接
- **list_recent**: 最近上传/修改的文件
- **search_by_tag**: 按标签搜索

## 工具调用格式

当需要查询数据时，使用以下格式输出工具调用（必须是合法JSON，包含在代码块中）：

\`\`\`tool_call
{"name": "工具名", "arguments": {"参数名": "参数值"}}
\`\`\`

等待工具结果后，根据结果继续回答。一次可以连续调用多个工具，但每次只能调用一个。

## 回答规范

1. **先调用工具获取实时数据，再回答** — 不要凭记忆猜测用户的文件情况
2. **列出文件时使用结构化格式** — 每个文件单独一行，格式：\`[FILE:id:name]\` 供系统渲染为可点击卡片
3. **列出文件夹时使用**：\`[FOLDER:id:name]\`
4. **数字精确** — 存储大小、文件数量等数据直接从工具结果读取，不要估算
5. **中文回答** — 除非用户使用其他语言
6. **回答要聚焦** — 直接给出结果，不要冗长铺垫

## 文件引用格式示例

当你需要列出文件时（工具返回后），请这样格式化：

用户共有 3 个 PDF 文件：
[FILE:abc123:2024年财务报告.pdf]
[FILE:def456:项目需求文档.pdf]
[FILE:ghi789:会议纪要.pdf]

## 能力边界

- 你只能**读取**文件信息，不能上传、删除、移动文件
- 你无法预览文件内容（除非文件已被AI索引并有摘要）
- 如果用户的文件未被AI索引，语义搜索可能效果有限，建议提示用户先做AI索引`;

// ────────────────────────────────────────────────────────────
// Agent Engine
// ────────────────────────────────────────────────────────────

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

const MAX_TOOL_ROUNDS = 5;
const TOOL_CALL_REGEX = /```tool_call\s*([\s\S]*?)```/;

export class AgentEngine {
  private executor: AgentToolExecutor;
  private gateway: ModelGateway;

  constructor(private env: Env) {
    this.executor = new AgentToolExecutor(env, ''); // userId set per-call
    this.gateway = new ModelGateway(env);
  }

  /**
   * Run the agent loop and emit chunks via onChunk callback.
   * Caller is responsible for wrapping in SSE stream.
   */
  async run(
    userId: string,
    query: string,
    conversationHistory: Array<{ role: string; content: string }>,
    modelId: string | undefined,
    onChunk: (chunk: AgentChunk) => void,
    signal?: AbortSignal
  ): Promise<{ fullText: string; sources: AgentSource[] }> {
    // Rebuild executor with correct userId
    (this.executor as any).userId = userId;

    // Build initial messages
    const messages: AgentMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ];

    // Inject recent conversation history (skip system messages)
    const historyTurns = conversationHistory.filter((m) => m.role !== 'system').slice(-8);
    for (const m of historyTurns) {
      messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }

    // Add current user query
    messages.push({ role: 'user', content: query });

    let fullText = '';
    const sources: AgentSource[] = [];
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      if (signal?.aborted) break;
      round++;

      // Call LLM
      let assistantContent = '';
      try {
        const response = await this.gateway.chatCompletion(
          userId,
          {
            messages: messages.map((m) => ({
              role: m.role as 'system' | 'user' | 'assistant',
              content: m.content,
            })),
            maxTokens: 2048,
            temperature: 0.3, // lower temp for more reliable tool calls
          },
          modelId,
          signal
        );
        assistantContent = response.content;
      } catch (error) {
        logger.error('AgentEngine', 'LLM call failed', { round }, error);
        onChunk({ type: 'error', message: 'AI 模型调用失败，请检查模型配置', done: true });
        return { fullText, sources };
      }

      // Check for tool call
      const toolMatch = TOOL_CALL_REGEX.exec(assistantContent);

      if (!toolMatch) {
        // No tool call — this is the final answer. Stream it.
        const finalText = assistantContent.trim();

        // Stream text char by char (simulate streaming for non-stream gateway)
        const CHUNK_SIZE = 8;
        for (let i = 0; i < finalText.length; i += CHUNK_SIZE) {
          if (signal?.aborted) break;
          const chunk = finalText.slice(i, i + CHUNK_SIZE);
          onChunk({ type: 'text', content: chunk, done: false });
          fullText += chunk;
          // Small yield to allow backpressure
          await new Promise((r) => setTimeout(r, 0));
        }

        // Add to message history
        messages.push({ role: 'assistant', content: assistantContent });
        break;
      }

      // Parse tool call
      let toolName: string;
      let toolArgs: Record<string, unknown>;
      try {
        const parsed = JSON.parse(toolMatch[1].trim());
        toolName = parsed.name;
        toolArgs = parsed.arguments || {};
      } catch (e) {
        logger.error('AgentEngine', 'Failed to parse tool call JSON', { raw: toolMatch[1] }, e);
        // Treat as plain text if JSON is malformed
        const finalText = assistantContent.replace(TOOL_CALL_REGEX, '').trim();
        onChunk({ type: 'text', content: finalText, done: false });
        fullText += finalText;
        messages.push({ role: 'assistant', content: assistantContent });
        break;
      }

      const toolCallId = `tc_${crypto.randomUUID().slice(0, 8)}`;

      // Emit any text before the tool call
      const textBefore = assistantContent.slice(0, toolMatch.index).trim();
      if (textBefore) {
        onChunk({ type: 'text', content: textBefore, done: false });
        fullText += textBefore;
      }

      // Emit tool start
      onChunk({ type: 'tool_start', toolName, toolCallId, args: toolArgs, done: false });
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute tool
      let toolResult: unknown;
      try {
        toolResult = await this.executor.execute(toolName, toolArgs);

        // Collect file sources for citation
        if (toolResult && typeof toolResult === 'object') {
          const r = toolResult as any;
          const fileList: any[] = r.files || (r.file ? [r.file] : []);
          for (const f of fileList.slice(0, 10)) {
            if (f.id && f.name && !sources.find((s) => s.id === f.id)) {
              sources.push({ id: f.id, name: f.name, mimeType: f.mimeType || null, score: 1.0 });
            }
          }
        }
      } catch (error) {
        toolResult = { error: error instanceof Error ? error.message : '工具执行失败' };
        logger.error('AgentEngine', 'Tool execution failed', { toolName, toolArgs }, error);
      }

      // Emit tool result
      onChunk({ type: 'tool_result', toolCallId, toolName, result: toolResult, done: false });

      // Add tool result to messages (as user-role tool response, works with all providers)
      const toolResultStr = JSON.stringify(toolResult, null, 2);
      messages.push({
        role: 'user',
        content: `[工具 ${toolName} 的执行结果]\n\`\`\`json\n${toolResultStr}\n\`\`\`\n\n请根据以上工具结果继续回答用户的问题。`,
      });
    }

    return { fullText, sources };
  }
}

// ────────────────────────────────────────────────────────────
// Utility: parse [FILE:id:name] markers from text → AgentSource[]
// ────────────────────────────────────────────────────────────

export function extractFileRefs(text: string): Array<{ id: string; name: string; isFolder: boolean }> {
  const refs: Array<{ id: string; name: string; isFolder: boolean }> = [];
  const fileRegex = /\[FILE:([^:]+):([^\]]+)\]/g;
  const folderRegex = /\[FOLDER:([^:]+):([^\]]+)\]/g;

  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(text))) {
    refs.push({ id: m[1], name: m[2], isFolder: false });
  }
  while ((m = folderRegex.exec(text))) {
    refs.push({ id: m[1], name: m[2], isFolder: true });
  }
  return refs;
}
