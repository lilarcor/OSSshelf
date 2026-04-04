-- Migration: 0021_ai_tasks
-- 将 AI 批处理任务进度从 KV 迁移至 D1
-- 解决 KV 并发计数丢失和任务状态不准确问题

CREATE TABLE IF NOT EXISTS ai_tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,          -- 'index' | 'summarize' | 'tags'
  status      TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed' | 'cancelled'
  total       INTEGER NOT NULL,
  processed   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  completed_at TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_tasks_user_type ON ai_tasks (user_id, type);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_status    ON ai_tasks (status);
