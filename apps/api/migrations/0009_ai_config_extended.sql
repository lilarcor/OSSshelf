-- 0009_ai_config_extended.sql
-- 扩展 AI 配置项，将硬编码值移至数据库配置

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. 更新已有的 vision.max_tokens 默认值（从 600 改为 2048）
-- ═══════════════════════════════════════════════════════════════════════════
UPDATE ai_config 
SET default_value = '2048', number_value = 2048, updated_at = datetime('now')
WHERE key = 'ai.vision.max_tokens';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Agent 配置
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO ai_config (id, key, category, label, description, value_type, number_value, default_value, is_editable, sort_order) VALUES
    ('cfg-agent-max-tokens', 'ai.agent.max_tokens', 'agent', 'Agent最大Token数', 'Agent对话响应时的最大输出token数', 'number', 2048, '2048', 1, 13),
    ('cfg-agent-temperature', 'ai.agent.temperature', 'agent', 'Agent温度参数', 'Agent对话时的温度参数（0-2之间，越低越确定）', 'number', 0.3, '0.3', 1, 14),
    ('cfg-agent-max-tool-calls', 'ai.agent.max_tool_calls', 'agent', '最大工具调用次数', '单次Agent响应中最大工具调用次数', 'number', 20, '20', 1, 15),
    ('cfg-agent-max-idle-rounds', 'ai.agent.max_idle_rounds', 'agent', '最大空转轮数', '连续无新文件信息后自动退出的轮数', 'number', 3, '3', 1, 16),
    ('cfg-agent-max-context-tokens', 'ai.agent.max_context_tokens', 'agent', '最大上下文Token数', 'Agent上下文最大token数', 'number', 10000, '10000', 1, 17),
    ('cfg-agent-reserve-tokens', 'ai.agent.reserve_tokens', 'agent', '预留Token数', '为响应预留的token数', 'number', 2500, '2500', 1, 18),
    ('cfg-agent-max-tool-result-chars', 'ai.agent.max_tool_result_chars', 'agent', '工具结果最大字符数', '单个工具结果的最大字符数（超长会被截断）', 'number', 15000, '15000', 1, 19),
    ('cfg-agent-image-timeout-ms', 'ai.agent.image_timeout_ms', 'agent', '图片分析超时(ms)', '单张图片分析的超时时间（毫秒）', 'number', 25000, '25000', 1, 20);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Tool 配置
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO ai_config (id, key, category, label, description, value_type, number_value, default_value, is_editable, sort_order) VALUES
    ('cfg-tool-max-image-size', 'ai.tool.max_image_size_bytes', 'tool', '图片最大大小(字节)', '允许AI分析的图片最大字节数（超过则跳过分析）', 'number', 5242880, '5242880', 1, 21),
    ('cfg-tool-text-chunk-size', 'ai.tool.text_chunk_size', 'tool', '文本分段大小', '读取文件内容时每段的字符数', 'number', 1500, '1500', 1, 22);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Feature 配置（AI功能输出token限制）
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO ai_config (id, key, category, label, description, value_type, number_value, default_value, is_editable, sort_order) VALUES
    ('cfg-feature-summary-max-tokens', 'ai.summary.max_tokens', 'feature', '摘要最大Token数', '生成文件摘要时的最大输出token数', 'number', 200, '200', 1, 23),
    ('cfg-feature-image-caption-max-tokens', 'ai.image_caption.max_tokens', 'feature', '图片描述最大Token数', '生成图片描述时的最大输出token数', 'number', 2048, '2048', 1, 24),
    ('cfg-feature-image-tag-max-tokens', 'ai.image_tag.max_tokens', 'feature', '图片标签最大Token数', '生成图片标签时的最大输出token数', 'number', 1024, '1024', 1, 25),
    ('cfg-feature-rename-max-tokens', 'ai.rename.max_tokens', 'feature', '重命名最大Token数', '智能重命名建议时的最大输出token数', 'number', 150, '150', 1, 26);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RAG 配置
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO ai_config (id, key, category, label, description, value_type, number_value, default_value, is_editable, sort_order) VALUES
    ('cfg-rag-max-files', 'ai.rag.max_files', 'rag', 'RAG最大文件数', 'RAG检索时返回的最大文件数', 'number', 5, '5', 1, 27),
    ('cfg-rag-max-context-length', 'ai.rag.max_context_length', 'rag', 'RAG最大上下文长度', 'RAG上下文的最大字符数', 'number', 8000, '8000', 1, 28);
