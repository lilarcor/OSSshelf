/**
 * openAiCompatibleAdapter.ts
 * OpenAI 兼容 API 适配器
 *
 * 功能:
 * - 支持所有 OpenAI 兼容的 API（OpenAI、Azure、Ollama、本地模型等）
 * - 支持流式输出（SSE）
 * - 支持 API Key 认证
 */

import type {
  IModelAdapter,
  ModelConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ChatContentPart,
} from '../types';
import { logger } from '@osshelf/shared';

export class OpenAiCompatibleAdapter implements IModelAdapter {
  readonly provider = 'openai_compatible' as const;
  readonly modelName = 'OpenAI Compatible';
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  async chatCompletion(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    this.validateConnection();

    try {
      const body: Record<string, unknown> = {
        model: this.config.modelId,
        messages: request.messages.map((msg) => ({
          role: msg.role,
          content: this.formatMessageContent(msg.content),
        })),
        max_tokens: request.maxTokens || this.config.maxTokens,
        temperature: request.temperature ?? this.config.temperature,
        stream: false,
      };

      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools;
        body.tool_choice = request.toolChoice || 'auto';
      }

      if (request.extraBody) {
        Object.assign(body, request.extraBody);
      }

      // DEBUG: log the first message content structure (truncate base64 for readability)
      const debugBody = JSON.parse(JSON.stringify(body));
      if (Array.isArray(debugBody.messages)) {
        debugBody.messages = debugBody.messages.map((m: any) => ({
          ...m,
          content: Array.isArray(m.content)
            ? m.content.map((p: any) =>
                p.type === 'image_url'
                  ? { type: p.type, image_url: { url: (p.image_url?.url || '').slice(0, 80) + '...[truncated]' } }
                  : p
              )
            : m.content,
        }));
      }
      logger.info('AI', '[DEBUG] vision request payload', { model: this.config.modelId, messages: JSON.stringify(debugBody.messages) });

      const response = await fetch(`${this.config.apiEndpoint}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        id: string;
        choices: Array<{
          message: {
            content: string | null;
            reasoning_content?: string | null;
            role: string;
            tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
          };
          finish_reason: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      logger.info('AI', '[DEBUG] API response', {
        id: data.id,
        choicesCount: data.choices?.length,
        firstChoiceFinishReason: data.choices?.[0]?.finish_reason,
        firstChoiceContentLength: data.choices?.[0]?.message?.content?.length,
        firstChoiceReasoningLength: data.choices?.[0]?.message?.reasoning_content?.length,
      });

      const choice = data.choices[0];
      // 智谱思考模式：优先使用 reasoning_content，否则使用 content
      const responseContent = choice?.message?.reasoning_content || choice?.message?.content || '';
      const toolCalls = choice?.message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

      return {
        id: data.id || crypto.randomUUID(),
        content: responseContent,
        role: 'assistant',
        model: this.config.modelId,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        finishReason: (choice?.finish_reason === 'tool_calls' ? 'tool_calls' : choice?.finish_reason) as
          | 'stop'
          | 'length'
          | 'content_filter'
          | 'tool_calls',
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      logger.error('AI', 'OpenAI compatible chat completion failed', {}, error);
      throw error;
    }
  }

  async chatCompletionStream(
    request: ChatCompletionRequest,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.validateConnection();

    try {
      // stream_options 仅在支持的模型上启用（不支持时部分 API 会报错）
      const supportsStreamOptions = !this.config.configJson?.disableStreamOptions;
      const streamBody: Record<string, unknown> = {
        model: this.config.modelId,
        messages: request.messages.map((msg) => ({
          role: msg.role,
          content: this.formatMessageContent(msg.content),
        })),
        max_tokens: request.maxTokens || this.config.maxTokens,
        temperature: request.temperature ?? this.config.temperature,
        stream: true,
        ...(supportsStreamOptions ? { stream_options: { include_usage: true } } : {}),
      };

      if (request.tools && request.tools.length > 0) {
        streamBody.tools = request.tools;
        streamBody.tool_choice = request.toolChoice || 'auto';
      }

      if (request.extraBody) {
        Object.assign(streamBody, request.extraBody);
      }

      const response = await fetch(`${this.config.apiEndpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(streamBody),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API stream error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const toolCallMap = new Map<number, { id?: string; name?: string; arguments: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done || signal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine === 'data: [DONE]') {
            if (trimmedLine === 'data: [DONE]') {
              // 如果 finish_reason=tool_calls 已经 emit 并 clear 了，这里 size=0，跳过
              if (toolCallMap.size > 0) {
                onChunk({
                  id: crypto.randomUUID(),
                  content: '',
                  role: 'assistant',
                  model: this.config.modelId,
                  done: false,
                  toolCalls: Array.from(toolCallMap.entries()).map(([index, tc]) => ({
                    id: tc.id || `tc_idx_${index}`,
                    name: tc.name || '',
                    arguments: tc.arguments,
                    index,
                  })),
                });
                toolCallMap.clear();
              }
              onChunk({
                id: crypto.randomUUID(),
                content: '',
                role: 'assistant',
                model: this.config.modelId,
                done: true,
              });
            }
            continue;
          }

          if (trimmedLine.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmedLine.slice(6));
              const choice = data.choices?.[0];
              const delta = choice?.delta;

              // 解析 usage（stream_options.include_usage=true 时，最后一个 chunk 含此字段）
              if (data.usage) {
                onChunk({
                  id: data.id || crypto.randomUUID(),
                  content: '',
                  role: 'assistant',
                  model: this.config.modelId,
                  done: false,
                  usage: {
                    promptTokens: data.usage.prompt_tokens,
                    completionTokens: data.usage.completion_tokens,
                    totalTokens: data.usage.total_tokens,
                  },
                });
              }

              if (delta?.content) {
                onChunk({
                  id: data.id || crypto.randomUUID(),
                  content: delta.content,
                  role: 'assistant',
                  model: this.config.modelId,
                  done: false,
                });
              }

              if (delta?.reasoning_content) {
                onChunk({
                  id: data.id || crypto.randomUUID(),
                  content: '',
                  role: 'assistant',
                  model: this.config.modelId,
                  done: false,
                  reasoningContent: delta.reasoning_content,
                });
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallMap.has(idx)) {
                    toolCallMap.set(idx, { arguments: '' });
                  }
                  const existing = toolCallMap.get(idx)!;
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                }
              }

              // finish_reason=tool_calls 时立即 emit（部分模型不发 [DONE] 或发送顺序不同）
              if (choice?.finish_reason === 'tool_calls' && toolCallMap.size > 0) {
                onChunk({
                  id: data.id || crypto.randomUUID(),
                  content: '',
                  role: 'assistant',
                  model: this.config.modelId,
                  done: false,
                  toolCalls: Array.from(toolCallMap.entries()).map(([index, tc]) => ({
                    id: tc.id || `tc_idx_${index}`,
                    name: tc.name || '',
                    arguments: tc.arguments,
                    index,
                  })),
                });
                toolCallMap.clear();
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        logger.error('AI', 'OpenAI compatible stream failed', {}, error);
      }
      throw error;
    }
  }

  async embedding(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.validateConnection();

    try {
      const response = await fetch(`${this.config.apiEndpoint}/embeddings`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.config.modelId,
          input: request.input,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI embedding error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
        model: string;
        usage?: {
          prompt_tokens: number;
          total_tokens: number;
        };
      };

      return {
        embeddings: data.data.map((item) => item.embedding),
        model: data.model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      logger.error('AI', 'OpenAI compatible embedding failed', {}, error);
      throw error;
    }
  }

  validateConfig(config: ModelConfig): { valid: boolean; error?: string } {
    if (!config.apiEndpoint) {
      return { valid: false, error: 'API endpoint is required' };
    }

    try {
      new URL(config.apiEndpoint);
    } catch {
      return { valid: false, error: 'Invalid API endpoint URL' };
    }

    if (!config.modelId) {
      return { valid: false, error: 'Model ID is required' };
    }

    return { valid: true };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const apiKey = this.config.apiKeyDecrypted || this.config.apiKeyEncrypted;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return headers;
  }

  private validateConnection(): void {
    if (!this.config.apiEndpoint) {
      throw new Error('API endpoint not configured');
    }
  }

  private formatMessageContent(
    content: string | ChatContentPart[]
  ): string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((part) => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        }
        if (part.type === 'image_url' && part.image_url) {
          return { type: 'image_url', image_url: part.image_url };
        }
        return null;
      })
      .filter(Boolean) as Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
  }

  static getPopularModels(): Array<{
    id: string;
    name: string;
    provider: string;
    capabilities: string[];
    description: string;
  }> {
    return [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'OpenAI',
        capabilities: ['chat', 'vision', 'function_calling'],
        description: 'OpenAI最新多模态模型，支持文本和图像理解',
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        provider: 'OpenAI',
        capabilities: ['chat', 'function_calling'],
        description: '高性能GPT-4模型，适合复杂任务',
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        provider: 'OpenAI',
        capabilities: ['chat'],
        description: '快速响应模型，适合简单任务',
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        provider: 'Anthropic',
        capabilities: ['chat', 'vision'],
        description: 'Anthropic最强模型，擅长复杂推理和分析',
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        provider: 'Anthropic',
        capabilities: ['chat', 'vision'],
        description: '平衡性能和速度的Claude模型',
      },
      {
        id: 'gemini-pro',
        name: 'Gemini Pro',
        provider: 'Google',
        capabilities: ['chat', 'function_calling'],
        description: 'Google的多模态模型',
      },
      {
        id: 'qwen-turbo',
        name: '通义千问 Turbo',
        provider: '阿里云',
        capabilities: ['chat'],
        description: '阿里云通义千问高速版，中文能力优秀',
      },
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        provider: 'DeepSeek',
        capabilities: ['chat'],
        description: 'DeepSeek对话模型，代码和推理能力强',
      },
    ];
  }
}
