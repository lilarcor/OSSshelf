-- 添加 tool_calls 和 reasoning 字段到 ai_chat_messages 表
ALTER TABLE ai_chat_messages ADD COLUMN tool_calls TEXT;
ALTER TABLE ai_chat_messages ADD COLUMN reasoning TEXT;


INSERT INTO ai_config (
  id, 
  key, 
  category, 
  label, 
  description, 
  value_type, 
  default_value, 
  string_value, 
  number_value, 
  boolean_value, 
  json_value, 
  is_editable, 
  sort_order, 
  created_at, 
  updated_at
) VALUES (
  lower(hex(randomblob(16))),
  'ai.agent.max_context_tokens',
  'agent',
  '最大上下文Token数',
  'Agent对话历史的最大Token预算，超出时裁剪最早的消息',
  'number',
  '100000',
  NULL,
  100000,
  NULL,
  NULL,
  1,
  21,
  datetime('now'),
  datetime('now')
);