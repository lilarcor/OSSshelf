-- 添加 tool_calls 和 reasoning 字段到 ai_chat_messages 表
ALTER TABLE ai_chat_messages ADD COLUMN tool_calls TEXT;
ALTER TABLE ai_chat_messages ADD COLUMN reasoning TEXT;
