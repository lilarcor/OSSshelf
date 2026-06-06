/**
 * Tags.tsx
 * 标签管理页面（独立路由 /tags）
 *
 * 功能:
 * - 查看所有标签及使用统计
 * - 搜索标签
 * - 点击标签查看关联文件
 * - 重命名标签
 * - 删除标签（从所有文件移除）
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { permissionsApi } from '@/services/api';
import { filesApi } from '@/services/api';
import { FileIcon } from '@/components/files/FileIcon';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/useToast';
import { formatBytes, formatDate } from '@/utils';
import type { FileItem, FileTag } from '@osshelf/shared';
import {
  Tag,
  Loader2,
  FolderOpen,
  Search,
  Pencil,
  Trash2,
  X,
  Check,
  Files,
  ArrowLeft,
} from 'lucide-react';
import { cn } from '@/utils';

export default function Tags() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // 获取所有用户标签
  const { data: tags = [], isLoading: tagsLoading } = useQuery<FileTag[]>({
    queryKey: ['user-tags'],
    queryFn: () => permissionsApi.getUserTags().then((r) => r.data.data ?? []),
    staleTime: 30000,
  });

  // 获取标签统计
  const { data: tagStats = [] } = useQuery<Array<{ name: string; count: number }>>({
    queryKey: ['tag-stats'],
    queryFn: () => permissionsApi.getTagStats().then((r) => r.data.data ?? []),
    staleTime: 30000,
  });

  // 获取选中标签的文件列表
  const { data: tagFiles = [], isLoading: filesLoading } = useQuery<FileItem[]>({
    queryKey: ['tag-files', selectedTag],
    queryFn: () =>
      filesApi.list({ tags: [selectedTag!] }).then((r) => r.data.data ?? []),
    enabled: !!selectedTag,
    staleTime: 30000,
  });

  // 重命名标签 mutation
  const renameMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      permissionsApi.renameTag({ oldName, newName }),
    onSuccess: () => {
      toast({ title: '标签已重命名' });
      queryClient.invalidateQueries({ queryKey: ['user-tags'] });
      queryClient.invalidateQueries({ queryKey: ['tag-stats'] });
      if (selectedTag === editingTag) {
        setSelectedTag(editName);
      }
      setEditingTag(null);
      setEditName('');
    },
    onError: (e: any) =>
      toast({
        title: '重命名失败',
        description: e.response?.data?.error?.message,
        variant: 'destructive',
      }),
  });

  // 删除标签 mutation
  const deleteMutation = useMutation({
    mutationFn: (tagName: string) => permissionsApi.deleteTag(tagName),
    onSuccess: () => {
      toast({ title: '标签已删除' });
      queryClient.invalidateQueries({ queryKey: ['user-tags'] });
      queryClient.invalidateQueries({ queryKey: ['tag-stats'] });
      if (selectedTag === deleteConfirm) {
        setSelectedTag(null);
      }
      setDeleteConfirm(null);
    },
    onError: (e: any) =>
      toast({
        title: '删除失败',
        description: e.response?.data?.error?.message,
        variant: 'destructive',
      }),
  });

  // 筛选标签
  const filteredTags = searchQuery
    ? tags.filter((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : tags;

  // 获取标签使用次数
  const getTagCount = (tagName: string) => {
    const stat = tagStats.find((s) => s.name === tagName);
    return stat?.count || 0;
  };

  // 处理文件点击
  const handleFileClick = (file: FileItem) => {
    if (file.isFolder) {
      navigate(`/files/${file.id}`);
    } else {
      navigate(`/files?preview=${file.id}`);
    }
  };

  // 处理重命名确认
  const handleRenameConfirm = (oldName: string) => {
    if (!editName.trim() || editName.trim() === oldName) {
      setEditingTag(null);
      return;
    }
    renameMutation.mutate({ oldName, newName: editName.trim() });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl lg:text-2xl font-bold flex items-center gap-2">
          <Tag className="h-5 w-5 lg:h-6 lg:w-6 text-primary" />
          标签管理
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {tagsLoading ? '加载中…' : `${tags.length} 个标签`}
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="搜索标签..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className={cn('grid gap-6', selectedTag ? 'lg:grid-cols-[320px_1fr]' : 'lg:grid-cols-1')}>
        {/* Tags List */}
        <div className="space-y-3">
          {tagsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredTags.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
              <Tag className="h-10 w-10 opacity-20" />
              <p className="text-sm font-medium">{searchQuery ? '未找到匹配的标签' : '暂无标签'}</p>
              <p className="text-xs">在文件详情中添加标签</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredTags.map((tag) => {
                const count = getTagCount(tag.name);
                const isSelected = selectedTag === tag.name;
                const isEditing = editingTag === tag.name;
                const isDeleting = deleteConfirm === tag.name;

                return (
                  <div
                    key={tag.id}
                    className={cn(
                      'group flex items-center gap-3 p-3 rounded-lg border transition-colors',
                      isSelected
                        ? 'bg-primary/10 border-primary/30'
                        : 'bg-card hover:bg-accent/40 border-transparent'
                    )}
                  >
                    {/* Tag Color & Name */}
                    <button
                      onClick={() => setSelectedTag(isSelected ? null : tag.name)}
                      className="flex-1 flex items-center gap-2.5 min-w-0 text-left"
                    >
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                      {isEditing ? (
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameConfirm(tag.name);
                            if (e.key === 'Escape') setEditingTag(null);
                          }}
                          className="h-7 text-sm flex-1"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          <span className="font-medium truncate text-sm">{tag.name}</span>
                          <span className="text-xs text-muted-foreground flex-shrink-0">{count} 个文件</span>
                        </>
                      )}
                    </button>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRenameConfirm(tag.name);
                            }}
                          >
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingTag(null);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : isDeleting ? (
                        <>
                          <span className="text-xs text-destructive mr-1">确定删除?</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteMutation.mutate(tag.name);
                            }}
                            disabled={deleteMutation.isPending}
                          >
                            {deleteMutation.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
                            ) : (
                              <Check className="h-3.5 w-3.5 text-destructive" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirm(null);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingTag(tag.name);
                              setEditName(tag.name);
                            }}
                            title="重命名"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirm(tag.name);
                            }}
                            title="删除"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Tag Files */}
        {selectedTag && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedTag(null)}
                  className="text-muted-foreground"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  返回
                </Button>
                <div className="h-4 w-px bg-border" />
                <h2 className="font-semibold">「{selectedTag}」相关文件</h2>
              </div>
              <span className="text-sm text-muted-foreground">
                {filesLoading ? '...' : `${tagFiles.length} 个文件`}
              </span>
            </div>

            {filesLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : tagFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
                <Files className="h-10 w-10 opacity-20" />
                <p className="text-sm font-medium">暂无相关文件</p>
              </div>
            ) : (
              <div className="grid gap-2">
                {tagFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/40 transition-colors cursor-pointer group overflow-hidden"
                    onClick={() => handleFileClick(file)}
                  >
                    <FileIcon mimeType={file.mimeType} isFolder={file.isFolder} size="md" />

                    <div className="flex-1 min-w-0 overflow-hidden">
                      <p className="font-medium truncate text-sm">{file.name}</p>
                      <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
                        <p className="flex items-center gap-1.5 overflow-hidden">
                          {!file.isFolder && <span className="flex-shrink-0">{formatBytes(file.size)}</span>}
                          {!file.isFolder && <span className="flex-shrink-0">·</span>}
                          <span className="flex-shrink-0 truncate">{formatDate(file.updatedAt)}</span>
                        </p>
                        {file.path && (
                          <p className="flex items-center gap-1 overflow-hidden">
                            <FolderOpen className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate">{file.path}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
