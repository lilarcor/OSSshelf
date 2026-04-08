/**
 * AdvancedConfigPanel.tsx
 * 高级系统配置面板组件
 *
 * 功能:
 * - 按分类展示系统配置项
 * - 支持布尔切换、模型选择、文本编辑
 * - 重置为默认值
 * - 移动端友好布局
 */

import { Sliders, RefreshCw, Save, RotateCcw, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';
import { useState } from 'react';
import type { AiSystemConfigItem, AiModel } from '@/services/api';

interface AdvancedConfigPanelProps {
  systemConfigs: AiSystemConfigItem[];
  configLoading: boolean;
  models: AiModel[];
  visionModels: AiModel[];
  modelCapabilityMap: Record<string, 'chat' | 'vision'>;
  editingConfigKey: string | null;
  configEditValue: string;
  onRefetch: () => void;
  onSave: (config: AiSystemConfigItem) => void;
  onSetEditingKey: (key: string | null) => void;
  onSetConfigEditValue: (value: string) => void;
  onUpdateMutation: (params: { key: string; value: unknown }) => void;
  onResetMutation: (key: string) => void;
  isUpdatePending: boolean;
  isResetPending: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  model: '🤖 默认模型',
  parameter: '⚙️ 模型参数',
  agent: '🤖 Agent 配置',
  tool: '🔧 工具配置',
  feature: '✨ 功能配置',
  rag: '📚 RAG 配置',
  retry: '🔄 重试策略',
  prompt: '💬 提示词模板',
};

function ConfigItem({
  config,
  models,
  editingConfigKey,
  configEditValue,
  onSetEditingKey,
  onSetConfigEditValue,
  onSave,
  onUpdateMutation,
  onResetMutation,
  isUpdatePending,
  isResetPending,
}: {
  config: AiSystemConfigItem;
  models: AiModel[];
  editingConfigKey: string | null;
  configEditValue: string;
  onSetEditingKey: (key: string | null) => void;
  onSetConfigEditValue: (value: string) => void;
  onSave: (config: AiSystemConfigItem) => void;
  onUpdateMutation: (params: { key: string; value: unknown }) => void;
  onResetMutation: (key: string) => void;
  isUpdatePending: boolean;
  isResetPending: boolean;
}) {
  const isEditing = editingConfigKey === config.key;
  const currentValue =
    config.valueType === 'string'
      ? (config.stringValue ?? '')
      : config.valueType === 'number'
        ? String(config.numberValue ?? '')
        : config.valueType === 'boolean'
          ? String(config.booleanValue)
          : (config.jsonValue ?? '');

  const isModelConfig = config.key.startsWith('ai.default_model.');
  const isModified = config.defaultValue !== currentValue;

  const renderInput = () => {
    if (config.valueType === 'boolean') {
      return (
        <button
          onClick={() => {
            if (!config.isEditable) return;
            onUpdateMutation({ key: config.key, value: !config.booleanValue });
          }}
          disabled={!config.isEditable || isUpdatePending}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0',
            config.booleanValue ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              config.booleanValue ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>
      );
    }

    if (isModelConfig) {
      return (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          <select
            value={currentValue}
            onChange={(e) => {
              onUpdateMutation({ key: config.key, value: e.target.value });
            }}
            disabled={!config.isEditable || isUpdatePending}
            className="flex-1 sm:flex-initial sm:min-w-[200px] px-3 py-2 border rounded-lg bg-background text-sm"
          >
            <option value={config.defaultValue}>{config.defaultValue} (系统默认)</option>
            {models
              .filter((m) => m.modelId !== config.defaultValue)
              .map((m) => (
                <option key={m.id} value={m.modelId}>
                  {m.name} ({m.provider})
                </option>
              ))}
          </select>
          {isModified && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onUpdateMutation({
                  key: config.key,
                  value: config.defaultValue,
                })
              }
              disabled={isUpdatePending}
              title="重置为默认值"
              className="self-end sm:self-auto"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              重置
            </Button>
          )}
        </div>
      );
    }

    if (isEditing) {
      return (
        <div className="flex flex-col sm:flex-row gap-2 w-full">
          <input
            type={config.valueType === 'number' ? 'number' : 'text'}
            value={configEditValue}
            onChange={(e) => onSetConfigEditValue(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg bg-background text-sm font-mono"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave(config);
              if (e.key === 'Escape') onSetEditingKey(null);
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onSave(config)} disabled={isUpdatePending} className="flex-1 sm:flex-initial">
              <Save className="h-3 w-3 mr-1" />
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSetEditingKey(null)} className="flex-1 sm:flex-initial">
              <X className="h-3 w-3 mr-1" />
              取消
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full">
        <code className="px-3 py-2 bg-muted rounded-lg text-sm font-mono flex-1 min-w-0 break-all">
          {currentValue || '(空)'}
        </code>
        <div className="flex gap-2">
          {config.isEditable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onSetEditingKey(config.key);
                onSetConfigEditValue(currentValue);
              }}
              className="flex-1 sm:flex-initial"
            >
              编辑
            </Button>
          )}
          {isModified && config.isEditable && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onResetMutation(config.key)}
              disabled={isResetPending}
              title="重置为默认值"
              className="flex-1 sm:flex-initial"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              重置
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      key={config.key}
      className={cn(
        'p-4 rounded-xl border space-y-3 transition-colors',
        !config.isEditable && 'opacity-75 bg-muted/30',
        isModified && 'border-primary/30 bg-primary/[0.02]'
      )}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{config.label}</span>
              {!config.isEditable && (
                <span className="px-1.5 py-0.5 bg-muted text-[10px] rounded text-muted-foreground">
                  系统只读
                </span>
              )}
              {isModified && (
                <span className="px-1.5 py-0.5 bg-primary/10 text-[10px] rounded text-primary">
                  已修改
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{config.description}</p>
          </div>
        </div>

        <div className="w-full">
          {renderInput()}
        </div>

        <p className="text-[10px] text-muted-foreground font-mono truncate">
          Key: {config.key}
        </p>
      </div>
    </div>
  );
}

export function AdvancedConfigPanel({
  systemConfigs,
  configLoading,
  models,
  visionModels,
  modelCapabilityMap,
  editingConfigKey,
  configEditValue,
  onRefetch,
  onSave,
  onSetEditingKey,
  onSetConfigEditValue,
  onUpdateMutation,
  onResetMutation,
  isUpdatePending,
  isResetPending,
}: AdvancedConfigPanelProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['model', 'parameter'])
  );

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  if (configLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <RefreshCw className="h-10 w-10 animate-spin text-muted-foreground mb-4" />
        <p className="text-sm text-muted-foreground">加载配置中...</p>
      </div>
    );
  }

  if (systemConfigs.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg sm:text-xl font-semibold">AI 系统配置</h2>
            <p className="text-sm text-muted-foreground mt-1">调整AI功能的核心参数和默认模型</p>
          </div>
        </div>
        <div className="text-center py-12 border-2 border-dashed rounded-xl">
          <Sliders className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-base sm:text-lg font-medium mb-2">暂无配置项</h3>
          <p className="text-sm text-muted-foreground">系统配置尚未初始化</p>
        </div>
      </div>
    );
  }

  const categories = ['model', 'parameter', 'agent', 'tool', 'feature', 'rag', 'retry', 'prompt'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold">AI 系统配置</h2>
          <p className="text-sm text-muted-foreground mt-1">调整AI功能的核心参数和默认模型</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefetch} disabled={configLoading}>
          {configLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          刷新
        </Button>
      </div>

      <div className="space-y-3">
        {categories.map((category) => {
          const categoryConfigs = systemConfigs.filter((c) => c.category === category);
          if (categoryConfigs.length === 0) return null;

          const isExpanded = expandedCategories.has(category);

          return (
            <section key={category} className="border rounded-xl overflow-hidden">
              <button
                onClick={() => toggleCategory(category)}
                className="w-full flex items-center justify-between p-4 bg-muted/30 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm sm:text-base">
                    {CATEGORY_LABELS[category] || category}
                  </h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] bg-muted text-muted-foreground">
                    {categoryConfigs.length}
                  </span>
                </div>
                {isExpanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {isExpanded && (
                <div className="p-3 sm:p-4 space-y-3">
                  {categoryConfigs.map((config) => {
                    const requiredCapability = modelCapabilityMap[config.key];
                    const availableModels = requiredCapability === 'vision' ? visionModels : models;

                    return (
                      <ConfigItem
                        key={config.key}
                        config={config}
                        models={availableModels}
                        editingConfigKey={editingConfigKey}
                        configEditValue={configEditValue}
                        onSetEditingKey={onSetEditingKey}
                        onSetConfigEditValue={onSetConfigEditValue}
                        onSave={onSave}
                        onUpdateMutation={onUpdateMutation}
                        onResetMutation={onResetMutation}
                        isUpdatePending={isUpdatePending}
                        isResetPending={isResetPending}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="p-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl text-sm text-muted-foreground">
        💡 提示：修改配置后立即生效。如遇问题可点击重置按钮恢复默认值。
      </div>
    </div>
  );
}
