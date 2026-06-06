/**
 * FileTagsManager.tsx
 * 文件标签管理组件
 *
 * 功能:
 * - 查看文件标签
 * - 添加/删除标签（点击+号弹出标签选择器）
 * - 标签选择器：展示已有标签列表（最多10个）、搜索、快速选择、新建
 * - 标签颜色选择
 */

import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { permissionsApi } from '@/services/api';
import { TAG_COLORS } from '@osshelf/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/useToast';
import { cn } from '@/utils';
import { Plus, X, Loader2, Search, Check } from 'lucide-react';

interface FileTagsManagerProps {
  fileId: string;
  onTagClick?: (tagName: string) => void;
}

export function FileTagsManager({ fileId, onTagClick }: FileTagsManagerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState<string>(TAG_COLORS[0] ?? '#6366f1');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // 当前文件的标签
  const { data: fileTags = [], isLoading: fileTagsLoading } = useQuery({
    queryKey: ['file-tags', fileId],
    queryFn: () => permissionsApi.getFileTags(fileId).then((r) => r.data.data ?? []),
  });

  // 用户所有已有标签（用于选择器）
  const { data: allTags = [], isLoading: tagsLoading } = useQuery({
    queryKey: ['user-tags'],
    queryFn: () => permissionsApi.getUserTags().then((r) => r.data.data ?? []),
    staleTime: 30000,
  });

  // 点击外部关闭选择器
  useEffect(() => {
    if (!showPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
        setTagSearch('');
        setShowCreateForm(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPicker]);

  // 过滤：排除已添加的 + 搜索匹配
  const availableTags = allTags.filter((t) => {
    const alreadyAdded = fileTags.some((ft) => ft.name === t.name);
    if (alreadyAdded) return false;
    if (!tagSearch) return true;
    return t.name.toLowerCase().includes(tagSearch.toLowerCase());
  });

  // 显示的标签：最多10个
  const displayTags = availableTags.slice(0, 10);

  // ── 添加已有标签到文件 ──
  const addTagMutation = useMutation({
    mutationFn: (data: { name: string; color?: string }) =>
      permissionsApi.addTag({ fileId, ...data }),
    onSuccess: () => {
      toast({ title: '标签已添加' });
      queryClient.invalidateQueries({ queryKey: ['file-tags', fileId] });
      queryClient.invalidateQueries({ queryKey: ['user-tags'] });
      queryClient.invalidateQueries({ queryKey: ['tag-stats'] });
    },
    onError: (e: any) =>
      toast({ title: '添加失败', description: e.response?.data?.error?.message, variant: 'destructive' }),
  });

  // ── 新建并添加标签 ──
  const createAndAddMutation = useMutation({
    mutationFn: async ({ name, color }: { name: string; color: string }) => {
      // 先创建标签，再添加到文件
      await permissionsApi.createTag({ name, color });
      await permissionsApi.addTag({ fileId, name, color });
    },
    onSuccess: () => {
      toast({ title: '标签已创建并添加' });
      queryClient.invalidateQueries({ queryKey: ['file-tags', fileId] });
      queryClient.invalidateQueries({ queryKey: ['user-tags'] });
      queryClient.invalidateQueries({ queryKey: ['tag-stats'] });
      setNewTagName('');
      setShowCreateForm(false);
      setTagSearch('');
    },
    onError: (e: any) =>
      toast({ title: '操作失败', description: e.response?.data?.error?.message, variant: 'destructive' }),
  });

  // ── 移除标签 ──
  const removeTagMutation = useMutation({
    mutationFn: (tagName: string) => permissionsApi.removeTag({ fileId, tagName }),
    onSuccess: () => {
      toast({ title: '标签已移除' });
      queryClient.invalidateQueries({ queryKey: ['file-tags', fileId] });
      queryClient.invalidateQueries({ queryKey: ['tag-stats'] });
    },
    onError: (e: any) =>
      toast({ title: '移除失败', description: e.response?.data?.error?.message, variant: 'destructive' }),
  });

  // 点击已有标签 → 直接添加
  const handleSelectExistingTag = (tag: { name: string; color: string }) => {
    addTagMutation.mutate({ name: tag.name, color: tag.color });
  };

  // 新建并添加
  const handleCreateAndAdd = () => {
    if (!newTagName.trim()) return;
    createAndAddMutation.mutate({ name: newTagName.trim(), color: selectedColor });
  };

  if (fileTagsLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  return (
    <div className="relative">
      {/* 已有标签 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {fileTags.map((tag) => (
          <button
            key={tag.id}
            onClick={() => onTagClick?.(tag.name)}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors',
              'hover:opacity-80'
            )}
            style={{ backgroundColor: tag.color + '20', color: tag.color }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
            {tag.name}
            <span
              role="button"
              tabIndex={0}
              className="ml-0.5 hover:bg-black/10 rounded-full p-0.5"
              onClick={(e) => {
                e.stopPropagation();
                removeTagMutation.mutate(tag.name);
              }}
            >
              <X className="h-2.5 w-2.5" />
            </span>
          </button>
        ))}

        {/* + 按钮 / 标签选择器 */}
        <div ref={pickerRef} className="relative">
          {!showPicker ? (
            <button
              onClick={() => setShowPicker(true)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-muted-foreground hover:bg-muted transition-colors"
            >
              <Plus className="h-3 w-3" />
              标签
            </button>
          ) : (
            /* 标签选择器弹出面板 */
            <div className="absolute left-0 top-full mt-1 z-50 w-72 rounded-lg border bg-card shadow-lg p-3 space-y-3">
              {/* 面板标题 */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">选择或创建标签</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setShowPicker(false); setTagSearch(''); setShowCreateForm(false); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* 搜索框 */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="搜索已有标签..."
                  value={tagSearch}
                  onChange={(e) => { setTagSearch(e.target.value); setShowCreateForm(false); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setShowPicker(false); }
                  }}
                  className="pl-8 h-8 text-xs"
                  autoFocus
                />
              </div>

              {/* 已有标签列表（最多显示10个） */}
              {!showCreateForm && (
                <>
                  {tagsLoading ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : displayTags.length > 0 ? (
                    <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
                      {displayTags.map((tag) => (
                        <button
                          key={tag.id}
                          onClick={() => handleSelectExistingTag(tag)}
                          disabled={addTagMutation.isPending}
                          className={cn(
                            'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-sm transition-colors',
                            'hover:bg-accent/60 disabled:opacity-50'
                          )}
                        >
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                          <span className="truncate flex-1">{tag.name}</span>
                          <Check className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-3">
                      {allTags.length === 0 ? '暂无标签' : '无匹配结果'}
                    </p>
                  )}

                  {/* "新建标签" 切换按钮 */}
                  <button
                    onClick={() => setShowCreateForm(true)}
                    className="w-full flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-primary hover:bg-primary/10 border border-dashed border-primary/30 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    新建标签
                  </button>
                </>
              )}

              {/* 新建标签表单 */}
              {showCreateForm && (
                <div className="space-y-2 pt-1 border-t">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="新标签名称"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateAndAdd()}
                      className="h-7 text-xs flex-1"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => { setShowCreateForm(false); setNewTagName(''); }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>

                  {/* 颜色选择 */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {TAG_COLORS.slice(0, 8).map((color) => (
                      <button
                        key={color}
                        onClick={() => setSelectedColor(color)}
                        className={cn(
                          'w-5 h-5 rounded-full border-2 transition-transform',
                          selectedColor === color ? 'scale-125 border-foreground' : 'border-transparent'
                        )}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>

                  <Button
                    size="sm"
                    className="w-full"
                    onClick={handleCreateAndAdd}
                    disabled={!newTagName.trim() || createAndAddMutation.isPending}
                  >
                    {createAndAddMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                    创建并添加
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function UserTagsList({ onTagClick }: { onTagClick?: (tagName: string) => void }) {
  const { data: tags = [], isLoading } = useQuery({
    queryKey: ['user-tags'],
    queryFn: () => permissionsApi.getUserTags().then((r) => r.data.data ?? []),
  });

  if (isLoading) return null;

  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <button
          key={tag.id}
          onClick={() => onTagClick?.(tag.name)}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors',
            'hover:opacity-80 cursor-pointer'
          )}
          style={{ backgroundColor: tag.color + '20', color: tag.color }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
          {tag.name}
        </button>
      ))}
    </div>
  );
}
