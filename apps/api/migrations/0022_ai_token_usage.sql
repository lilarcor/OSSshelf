-- AI Token 使用记录表
-- 用于记录用户每日 AI Token 使用量，支持历史查询

CREATE TABLE IF NOT EXISTS ai_token_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  quota INTEGER NOT NULL DEFAULT 100000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_token_usage_user ON ai_token_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_date ON ai_token_usage(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_token_usage_unique ON ai_token_usage(user_id, date);
