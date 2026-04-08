-- 添加AI提供商表和扩展AI模型表
-- 添加 ai_providers 表用于管理自定义提供商
-- 在 ai_models 表中添加 providerId 和 sortOrder 字段

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai_compatible',
  api_endpoint TEXT,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_user_active ON ai_providers(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user_default ON ai_providers(user_id, is_default);

ALTER TABLE ai_models ADD COLUMN provider_id TEXT REFERENCES ai_providers(id) ON DELETE SET NULL;
ALTER TABLE ai_models ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- 插入默认提供商数据（基于现有适配器）
-- 注意：这些是系统内置的提供商，不关联特定用户
INSERT OR IGNORE INTO ai_providers (id, user_id, name, type, api_endpoint, description, is_default, is_active, sort_order, created_at, updated_at)
VALUES 
  ('provider-workers-ai', 'system', 'Cloudflare Workers AI', 'workers_ai', NULL, 'Cloudflare Workers AI 内置模型，无需配置API端点', 0, 1, 100, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('provider-openai', 'system', 'OpenAI', 'openai_compatible', 'https://api.openai.com/v1', 'OpenAI 官方API', 0, 1, 90, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('provider-deepseek', 'system', 'DeepSeek', 'openai_compatible', 'https://api.deepseek.com/v1', 'DeepSeek API', 0, 1, 80, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('provider-volcengine', 'system', '火山引擎', 'openai_compatible', 'https://ark.cn-beijing.volces.com/api/v3', '火山引擎豆包API', 0, 1, 70, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('provider-zhipu', 'system', '智谱AI', 'openai_compatible', 'https://open.bigmodel.cn/api/paas/v4', '智谱GLM API', 0, 1, 60, datetime('now', 'localtime'), datetime('now', 'localtime')),
  ('provider-siliconflow', 'system', 'SiliconFlow', 'openai_compatible', 'https://api.siliconflow.cn/v1', 'SiliconFlow API', 0, 1, 50, datetime('now', 'localtime'), datetime('now', 'localtime'));
