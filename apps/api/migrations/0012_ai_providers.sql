-- 添加AI提供商表和扩展AI模型表
-- 添加 ai_providers 表用于管理自定义提供商
-- 在 ai_models 表中添加 providerId 和 sortOrder 字段

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_en TEXT,
  type TEXT NOT NULL DEFAULT 'openai_compatible',
  api_endpoint TEXT,
  description TEXT,
  thinking_config TEXT,
  features TEXT DEFAULT '{"thinking":false,"functionCalling":true,"streaming":true,"vision":false}',
  is_system INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_user_active ON ai_providers(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user_default ON ai_providers(user_id, is_default);
CREATE INDEX IF NOT EXISTS idx_ai_providers_system ON ai_providers(is_system);

ALTER TABLE ai_models ADD COLUMN provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL;
ALTER TABLE ai_models ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- 插入系统内置提供商数据（基于 vendorConfig.ts）
-- is_system = 1 表示系统内置，user_id 为 NULL
INSERT OR IGNORE INTO ai_providers (id, user_id, name, name_en, type, api_endpoint, description, thinking_config, features, is_system, is_default, is_active, sort_order, created_at, updated_at)
VALUES 
  -- 国内厂商
  ('vendor-baidu', NULL, '百度文心一言', 'Baidu ERNIE', 'openai_compatible', 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', '百度文心一言大模型', '{"paramFormat":"boolean","paramName":"enable_thinking","enabledValue":true,"disabledValue":false}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 100, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-tencent', NULL, '腾讯混元', 'Tencent Hunyuan', 'openai_compatible', 'https://api.hunyuan.cloud.tencent.com/v1', '腾讯混元大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 99, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-alibaba', NULL, '阿里通义千问', 'Alibaba Qwen', 'openai_compatible', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '阿里通义千问大模型', '{"paramFormat":"boolean","paramName":"enable_thinking","enabledValue":true,"disabledValue":false}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 98, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-volcengine', NULL, '字节火山引擎', 'Volcengine Doubao', 'openai_compatible', 'https://ark.cn-beijing.volces.com/api/v3', '字节跳动火山引擎豆包大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 97, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-zhipu', NULL, '智谱AI', 'Zhipu GLM', 'openai_compatible', 'https://open.bigmodel.cn/api/paas/v4', '智谱GLM大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 96, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-minimax', NULL, 'MiniMax', 'MiniMax', 'openai_compatible', 'https://api.minimax.chat/v1', 'MiniMax大模型', NULL, '{"thinking":true,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 95, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-moonshot', NULL, '月之暗面', 'Moonshot Kimi', 'openai_compatible', 'https://api.moonshot.cn/v1', '月之暗面Kimi大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 94, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-siliconflow', NULL, '硅基流动', 'SiliconFlow', 'openai_compatible', 'https://api.siliconflow.cn/v1', '硅基流动模型聚合平台', '{"paramFormat":"boolean","paramName":"enable_thinking","enabledValue":true,"disabledValue":false}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 93, datetime('now', 'localtime'), datetime('now', 'localtime')),
  
  -- 国际厂商
  ('vendor-openai', NULL, 'OpenAI', 'OpenAI', 'openai_compatible', 'https://api.openai.com/v1', 'OpenAI GPT系列模型', '{"paramFormat":"string","paramName":"reasoning_effort","enabledValue":"medium","disabledValue":"low"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 90, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-anthropic', NULL, 'Anthropic Claude', 'Claude', 'openai_compatible', 'https://api.anthropic.com/v1', 'Anthropic Claude系列模型（需使用兼容适配器）', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 89, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-google', NULL, 'Google Gemini', 'Gemini', 'openai_compatible', 'https://generativelanguage.googleapis.com/v1beta', 'Google Gemini系列模型', '{"paramFormat":"string","paramName":"thinking_level","enabledValue":"high","disabledValue":"low"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 88, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-mistral', NULL, 'Mistral AI', 'Mistral', 'openai_compatible', 'https://api.mistral.ai/v1', 'Mistral AI大模型', NULL, '{"thinking":false,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 87, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-xai', NULL, 'xAI Grok', 'xAI Grok', 'openai_compatible', 'https://api.x.ai/v1', 'xAI Grok系列模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 86, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-groq', NULL, 'Groq', 'Groq', 'openai_compatible', 'https://api.groq.com/openai/v1', 'Groq高速推理平台', NULL, '{"thinking":false,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 85, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-perplexity', NULL, 'Perplexity', 'Perplexity', 'openai_compatible', 'https://api.perplexity.ai', 'Perplexity联网搜索模型', NULL, '{"thinking":false,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 84, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-openrouter', NULL, 'OpenRouter', 'OpenRouter', 'openai_compatible', 'https://openrouter.ai/api/v1', 'OpenRouter模型聚合平台', NULL, '{"thinking":true,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 83, datetime('now', 'localtime'), datetime('now', 'localtime')),
  
  -- Cloudflare Workers AI（特殊处理）
  ('vendor-workers-ai', NULL, 'Cloudflare Workers AI', 'Workers AI', 'workers_ai', NULL, 'Cloudflare Workers AI内置模型，无需配置API端点', NULL, '{"thinking":false,"functionCalling":true,"streaming":true,"vision":true}', 1, 0, 1, 80, datetime('now', 'localtime'), datetime('now', 'localtime')),
  
  -- DeepSeek（单独列出，常用）
  ('vendor-deepseek', NULL, 'DeepSeek', 'DeepSeek', 'openai_compatible', 'https://api.deepseek.com/v1', 'DeepSeek深度求索大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', '{"thinking":true,"functionCalling":true,"streaming":true,"vision":false}', 1, 0, 1, 91, datetime('now', 'localtime'), datetime('now', 'localtime'));
