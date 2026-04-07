-- 0011_ai_models_extended.sql
-- 扩展 ai_models 表，添加更多配置项字段

ALTER TABLE ai_models ADD COLUMN context_length INTEGER DEFAULT 4096;
ALTER TABLE ai_models ADD COLUMN max_output_tokens INTEGER DEFAULT 4096;
ALTER TABLE ai_models ADD COLUMN supports_thinking INTEGER DEFAULT 0;
ALTER TABLE ai_models ADD COLUMN supports_function_calling INTEGER DEFAULT 1;
ALTER TABLE ai_models ADD COLUMN supports_streaming INTEGER DEFAULT 1;
ALTER TABLE ai_models ADD COLUMN supports_vision INTEGER DEFAULT 0;
ALTER TABLE ai_models ADD COLUMN thinking_param_format TEXT;
ALTER TABLE ai_models ADD COLUMN thinking_param_name TEXT;
ALTER TABLE ai_models ADD COLUMN thinking_enabled_value TEXT;
ALTER TABLE ai_models ADD COLUMN thinking_disabled_value TEXT;
ALTER TABLE ai_models ADD COLUMN thinking_nested_key TEXT;
ALTER TABLE ai_models ADD COLUMN disable_thinking_for_features TEXT DEFAULT '["image_caption","image_tag","image_analysis","file_summary"]';
ALTER TABLE ai_models ADD COLUMN vendor_specific_config TEXT DEFAULT '{}';
ALTER TABLE ai_models ADD COLUMN is_readonly INTEGER DEFAULT 0;
