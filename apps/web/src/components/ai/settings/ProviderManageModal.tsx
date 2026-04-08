/**
 * ProviderManageModal.tsx
 * 提供商管理弹窗组件
 */

import { useState, useEffect } from 'react';
import { X, Plus, Edit2, Trash2, Star, Loader2, Building2, Link } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { aiApi, type AiProviderItem, type CreateAiProviderParams } from '@/services/api';

interface ProviderManageModalProps {
  onClose: () => void;
  onProviderChange?: () => void;
}

export function ProviderManageModal({ onClose, onProviderChange }: ProviderManageModalProps) {
  const [providers, setProviders] = useState<AiProviderItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<AiProviderItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<CreateAiProviderParams>({
    name: '',
    apiEndpoint: '',
    description: '',
    isDefault: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      setIsLoading(true);
      const res = await aiApi.config.getAiProviders();
      if (res.data.success && res.data.data) {
        setProviders(res.data.data);
      }
    } catch (error) {
      console.error('Failed to load providers:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;

    try {
      setIsSubmitting(true);
      if (editingProvider) {
        await aiApi.config.updateAiProvider(editingProvider.id, formData);
      } else {
        await aiApi.config.createAiProvider(formData);
      }
      await loadProviders();
      onProviderChange?.();
      setShowForm(false);
      setEditingProvider(null);
      setFormData({
        name: '',
        apiEndpoint: '',
        description: '',
        isDefault: false,
      });
    } catch (error) {
      console.error('Failed to save provider:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (provider: AiProviderItem) => {
    setEditingProvider(provider);
    setFormData({
      name: provider.name,
      apiEndpoint: provider.apiEndpoint || '',
      description: provider.description || '',
      isDefault: provider.isDefault,
    });
    setShowForm(true);
  };

  const handleDelete = async (providerId: string) => {
    if (!confirm('确定要删除此提供商吗？关联的模型将变为自定义类型。')) return;

    try {
      setDeletingId(providerId);
      await aiApi.config.deleteAiProvider(providerId);
      await loadProviders();
      onProviderChange?.();
    } catch (error) {
      console.error('Failed to delete provider:', error);
    } finally {
      setDeletingId(null);
    }
  };

  const handleSetDefault = async (providerId: string) => {
    try {
      await aiApi.config.setDefaultProvider(providerId);
      await loadProviders();
      onProviderChange?.();
    } catch (error) {
      console.error('Failed to set default provider:', error);
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingProvider(null);
    setFormData({
      name: '',
      apiEndpoint: '',
      description: '',
      isDefault: false,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-4 sm:p-6 border-b sticky top-0 bg-card z-10">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg sm:text-xl font-semibold">管理提供商</h2>
              <p className="text-xs text-muted-foreground mt-1">
                添加和管理AI服务提供商（OpenAI兼容API）
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : showForm ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  提供商名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded bg-background text-sm"
                  placeholder="如: 火山引擎、智谱AI"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">API 端点</label>
                <input
                  type="text"
                  value={formData.apiEndpoint}
                  onChange={(e) => setFormData({ ...formData, apiEndpoint: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded bg-background text-sm font-mono"
                  placeholder="如: https://api.deepseek.com/v1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  API基础URL，不包含 /chat/completions 等路径
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">描述</label>
                <textarea
                  value={formData.description || ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded bg-background text-sm"
                  rows={2}
                  placeholder="提供商描述（可选）"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={formData.isDefault}
                  onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="isDefault" className="text-sm">
                  设为默认提供商
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button type="button" variant="outline" onClick={handleCancel}>
                  取消
                </Button>
                <Button type="submit" disabled={isSubmitting || !formData.name.trim()}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      保存中...
                    </>
                  ) : (
                    editingProvider ? '更新' : '创建'
                  )}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex justify-between items-center mb-4">
                <span className="text-sm text-muted-foreground">
                  共 {providers.length} 个提供商（蓝色为系统内置）
                </span>
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  添加提供商
                </Button>
              </div>

              {providers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Building2 className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">暂无提供商</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {providers.map((provider) => (
                    <div
                      key={provider.id}
                      className={`p-3 border rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${
                        provider.isSystem
                          ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{provider.name}</span>
                          {provider.isSystem && (
                            <span className="px-1.5 py-0.5 text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                              系统
                            </span>
                          )}
                          {provider.isDefault && (
                            <span className="px-1.5 py-0.5 text-[10px] bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded">
                              默认
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {provider.apiEndpoint && (
                            <span className="text-xs text-muted-foreground font-mono truncate max-w-[150px]">
                              {provider.apiEndpoint}
                            </span>
                          )}
                          {!provider.isSystem && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => handleSetDefault(provider.id)}
                                title="设为默认"
                              >
                                <Star className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => handleEdit(provider)}
                                title="编辑"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-red-500 hover:text-red-600"
                                onClick={() => handleDelete(provider.id)}
                                disabled={deletingId === provider.id}
                                title="删除"
                              >
                                {deletingId === provider.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProviderManageModal;
