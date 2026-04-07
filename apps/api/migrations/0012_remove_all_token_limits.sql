-- 0012_remove_all_token_limits.sql
-- SQLite 不支持 DROP COLUMN，需要重建表
-- 删除所有 token 限制字段：max_tokens

-- 步骤 1: 创建新表（不包含 max_tokens 字段）
CREATE TABLE ai_models_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'workers_ai',
  model_id TEXT NOT NULL,
  api_endpoint TEXT,
  api_key_encrypted TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '["chat","completion"]',
  temperature REAL DEFAULT 0.7,
  system_prompt TEXT,
  config_json TEXT DEFAULT '{}',
  supports_thinking INTEGER DEFAULT 0,
  thinking_param_format TEXT,
  thinking_param_name TEXT,
  thinking_enabled_value TEXT,
  thinking_disabled_value TEXT,
  thinking_nested_key TEXT,
  disable_thinking_for_features TEXT DEFAULT '["image_caption","image_tag","image_analysis","file_summary"]',
  is_readonly INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 步骤 2: 从旧表复制数据到新表（排除 max_tokens 字段）
INSERT INTO ai_models_new (
  id, user_id, name, provider, model_id, api_endpoint, api_key_encrypted,
  is_active, capabilities, temperature, system_prompt, config_json,
  supports_thinking, thinking_param_format, thinking_param_name,
  thinking_enabled_value, thinking_disabled_value, thinking_nested_key,
  disable_thinking_for_features, is_readonly, created_at, updated_at
)
SELECT
  id, user_id, name, provider, model_id, api_endpoint, api_key_encrypted,
  is_active, capabilities, temperature, system_prompt, config_json,
  supports_thinking, thinking_param_format, thinking_param_name,
  thinking_enabled_value, thinking_disabled_value, thinking_nested_key,
  disable_thinking_for_features, is_readonly, created_at, updated_at
FROM ai_models;

-- 步骤 3: 删除旧表
DROP TABLE ai_models;

-- 步骤 4: 重命名新表为旧表名
ALTER TABLE ai_models_new RENAME TO ai_models;

-- 步骤 5: 重建索引
CREATE INDEX idx_ai_models_user_active ON ai_models(user_id, is_active);
CREATE INDEX idx_ai_models_user_provider ON ai_models(user_id, provider);
