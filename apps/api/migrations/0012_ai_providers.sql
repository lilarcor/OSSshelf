-- 添加AI提供商表和扩展AI模型表
-- 添加 ai_providers 表用于管理自定义提供商
-- 在 ai_models 表中添加 providerId 和 sortOrder 字段

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  api_endpoint TEXT,
  description TEXT,
  thinking_config TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_system ON ai_providers(is_system);

ALTER TABLE ai_models ADD COLUMN provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL;
ALTER TABLE ai_models ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- 插入系统内置提供商数据（基于 vendorConfig.ts）
-- is_system = 1 表示系统内置，user_id 为 NULL
-- thinking_config 格式: {"paramFormat":"object|boolean|string","paramName":"xxx","nestedKey":"xxx","enabledValue":"xxx","disabledValue":"xxx"}
INSERT OR IGNORE INTO ai_providers (id, user_id, name, api_endpoint, description, thinking_config, is_system, is_default, is_active, sort_order, created_at, updated_at)
VALUES 
  -- 国内厂商
  ('vendor-baidu', NULL, '百度文心一言', 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', '百度文心一言大模型', '{"paramFormat":"boolean","paramName":"enable_thinking","enabledValue":true,"disabledValue":false}', 1, 0, 1, 100, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-tencent', NULL, '腾讯混元', 'https://api.hunyuan.cloud.tencent.com/v1', '腾讯混元大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 99, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-alibaba', NULL, '阿里通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '阿里通义千问大模型', '{"paramFormat":"boolean","paramName":"enable_thinking","enabledValue":true,"disabledValue":false}', 1, 0, 1, 98, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-volcengine', NULL, '字节火山引擎', 'https://ark.cn-beijing.volces.com/api/v3', '字节跳动火山引擎豆包大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 97, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-zhipu', NULL, '智谱AI', 'https://open.bigmodel.cn/api/paas/v4', '智谱GLM大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 96, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-minimax', NULL, 'MiniMax', 'https://api.minimax.chat/v1', 'MiniMax大模型', NULL, 1, 0, 1, 95, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-moonshot', NULL, '月之暗面', 'https://api.moonshot.cn/v1', '月之暗面Kimi大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 94, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-siliconflow', NULL, '硅基流动', 'https://api.siliconflow.cn/v1', '硅基流动模型聚合平台', '{"paramFormat":"boolean","paramName":"enable_thinking","enabledValue":true,"disabledValue":false}', 1, 0, 1, 93, datetime('now', 'localtime'), datetime('now', 'localtime')),
  
  -- 国际厂商
  ('vendor-openai', NULL, 'OpenAI', 'https://api.openai.com/v1', 'OpenAI GPT系列模型', '{"paramFormat":"string","paramName":"reasoning_effort","enabledValue":"medium","disabledValue":"low"}', 1, 0, 1, 90, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-anthropic', NULL, 'Anthropic Claude', 'https://api.anthropic.com/v1', 'Anthropic Claude系列模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 89, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-google', NULL, 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta', 'Google Gemini系列模型', '{"paramFormat":"string","paramName":"thinking_level","enabledValue":"high","disabledValue":"low"}', 1, 0, 1, 88, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-mistral', NULL, 'Mistral AI', 'https://api.mistral.ai/v1', 'Mistral AI大模型', NULL, 1, 0, 1, 87, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-xai', NULL, 'xAI Grok', 'https://api.x.ai/v1', 'xAI Grok系列模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 86, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-groq', NULL, 'Groq', 'https://api.groq.com/openai/v1', 'Groq高速推理平台', NULL, 1, 0, 1, 85, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-perplexity', NULL, 'Perplexity', 'https://api.perplexity.ai', 'Perplexity联网搜索模型', NULL, 1, 0, 1, 84, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('vendor-openrouter', NULL, 'OpenRouter', 'https://openrouter.ai/api/v1', 'OpenRouter模型聚合平台', NULL, 1, 0, 1, 83, datetime('now', 'localtime'), datetime('now', 'localtime')),
  
  -- DeepSeek（单独列出，常用）
  ('vendor-deepseek', NULL, 'DeepSeek', 'https://api.deepseek.com/v1', 'DeepSeek深度求索大模型', '{"paramFormat":"object","paramName":"thinking","nestedKey":"type","enabledValue":"enabled","disabledValue":"disabled"}', 1, 0, 1, 91, datetime('now', 'localtime'), datetime('now', 'localtime'));
