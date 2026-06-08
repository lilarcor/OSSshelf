/**
 * TeamWorkspace.tsx — 团队工作区 V3（修复版）
 *
 * 修复：
 * - 使用 api 客户端（带 auth token）替代裸 fetch
 * - 调用 /workspace/all-files 端点（合并挂载+团队自有文件）
 * - 上传功能接入 presignUpload 流程
 */

import React, { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/useToast';
import { teamsApi, type WorkspaceFile } from '@/services/collab';
import api from '@/services/api-client';
import {
  FolderOpen, File, HardDrive, Users, Loader2, Grid, List,
  RefreshCw, Lock, Edit, Crown, Plus, Upload, Trash2,
  FolderPlus, Eye, Download, ChevronRight, X,
} from 'lucide-react';
import { cn, formatBytes } from '@/utils';
import type { ViewMode } from '@/stores/files';
import TeamStorageBar from './TeamStorageBar';
import TeamActivityFeed from './TeamActivityFeed';

interface TeamWorkspaceProps {
  teamId: string;
  teamName: string;
  userRole: string;
  isOwner: boolean;
}

type WorkspaceTab = 'files' | 'activity';

const TeamWorkspace: React.FC<TeamWorkspaceProps> = ({ teamId, teamName, userRole, isOwner }) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('files');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [contextMenuFile, setContextMenuFile] = useState<WorkspaceFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<WorkspaceFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canWrite = userRole === 'admin' || userRole === 'owner' || isOwner;

  // ★ 使用 all-files 端点（合并挂载资源 + 团队自有文件）
  const { data: filesData, isLoading: isFilesLoading, refetch: refetchFiles } = useQuery({
    queryKey: ['team-workspace-all', teamId, currentFolderId],
    queryFn: () =>
      api.get<{ success: boolean; data: { files: (WorkspaceFile & { source: string })[]; total: number } }>(
        `/api/teams/${teamId}/workspace/all-files${currentFolderId ? `?folderId=${currentFolderId}` : ''}`
      ).then((r) => r.data.data),
  });

  const { data: storageData } = useQuery({
    queryKey: ['team-storage', teamId],
    queryFn: () => teamsApi.getStorageStats(teamId).then((r) => r.data.data),
  });

  const files = filesData?.files ?? [];
  const total = filesData?.total ?? 0;

  // ── 新建文件夹（使用 api 客户端，自动带 auth）──
  const createFolderMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<{ success: boolean; data: { id: string; name: string }; error?: { message: string } }>(
        `/api/teams/${teamId}/workspace/folder`,
        { name }
      ),
    onSuccess: (res) => {
      const body = res.data;
      if (!body.success) {
        toast({ title: '创建失败', description: body.error?.message || '未知错误', variant: 'destructive' });
        return;
      }
      toast({ title: '文件夹创建成功' });
      setIsCreatingFolder(false);
      setNewFolderName('');
      queryClient.invalidateQueries({ queryKey: ['team-workspace-all'] });
    },
    onError: (e: any) => {
      toast({ title: '创建失败', description: e.response?.data?.error?.message || e.message, variant: 'destructive' });
    },
  });

  // ── 删除文件（使用 api 客户端）──
  const deleteMutation = useMutation({
    mutationFn: (fileId: string) =>
      api.delete<{ success: boolean; error?: { message: string } }>(`/api/files/${fileId}`),
    onSuccess: (res) => {
      const body = res.data;
      if (!body.success) {
        toast({ title: '删除失败', description: body.error?.message, variant: 'destructive' });
        return;
      }
      toast({ title: '已删除' });
      setSelectedFileIds(new Set());
      refetchFiles();
    },
    onError: (e: any) => {
      toast({ title: '删除失败', description: e.response?.data?.error?.message || e.message, variant: 'destructive' });
    },
  });

  // ── 上传文件（使用 presignUpload）──
  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    try {
      // 动态导入 presignUpload 避免未使用时的加载开销
      const { presignUpload } = await import('@/services/presignUpload');

      for (const file of Array.from(fileList)) {
        try {
          await presignUpload({ file, parentId: null }); // 上传到用户根目录（后续可指定团队文件夹）
          toast({ title: `${file.name} 上传成功` });
        } catch (uploadErr: any) {
          toast({ title: `${file.name} 上传失败`, description: uploadErr.message, variant: 'destructive' });
        }
      }

      // 清空 input 以便重复选择同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
      refetchFiles();
    } catch (err) {
      toast({ title: '上传模块加载失败', variant: 'destructive' });
    }
  };

  // ── 选择/取消选择 ──
  const toggleSelect = useCallback((fileId: string) => {
    setSelectedFileIds(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId); else next.add(fileId);
      return next;
    });
  }, []);

  const PermissionBadge = ({ permission }: { permission: string }) => {
    if (permission === 'admin') return <Crown className="h-3.5 w-3.5 text-purple-500" />;
    if (permission === 'write') return <Edit className="h-3.5 w-3.5 text-blue-500" />;
    return <Lock className="h-3.5 w-3.5 text-gray-400" />;
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    createFolderMutation.mutate(newFolderName.trim());
  };

  // ── 下载文件 ──
  const handleDownload = (file: WorkspaceFile) => {
    const downloadUrl = `/api/files/${file.fileId}/download`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = file.fileName;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-4" onClick={() => setContextMenuFile(null)}>
      {/* 头部信息 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">{teamName}</h2>
            <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full flex items-center gap-1">
              <Users className="h-3 w-3" /> 工作区
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">团队共享空间 · {total} 个项目</p>
          {/* 面包屑导航 */}
          {currentFolderId && (
            <div className="flex items-center gap-1 text-sm mt-1">
              <button
                onClick={() => setCurrentFolderId(undefined)}
                className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <FolderOpen className="h-3.5 w-3.5" /> 根目录
              </button>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="text-foreground font-medium">子文件夹</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {storageData && (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <HardDrive className="h-3.5 w-3.5" /> {storageData.usagePercent}%
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={() => refetchFiles()}>
            <RefreshCw className={cn('h-4 w-4', isFilesLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 存储条 */}
      {storageData && <TeamStorageBar stats={storageData} />}

      {/* Tab 切换 */}
      <div className="flex gap-1 border-b">
        {([
          { key: 'files' as WorkspaceTab, label: '文件', icon: <FolderOpen className="h-4 w-4" /> },
          { key: 'activity' as WorkspaceTab, label: '动态', icon: <Users className="h-4 w-4" /> },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={cn(
            'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            activeTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}>
            {tab.icon} {tab.label} {tab.key === 'files' && ` (${total})`}
          </button>
        ))}
      </div>

      {/* ====== 文件 Tab ====== */}
      {activeTab === 'files' && (
        <div className="space-y-3">
          {/* 工具栏 */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1">
              <Button variant={viewMode === 'list' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('list')}>
                <List className="h-4 w-4" />
              </Button>
              <Button variant={viewMode === 'grid' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('grid')}>
                <Grid className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              {/* 新建文件夹 */}
              {canWrite && (
                <>
                  {!isCreatingFolder ? (
                    <Button variant="outline" size="sm" onClick={() => setIsCreatingFolder(true)}>
                      <FolderPlus className="h-4 w-4 mr-1" /> 新建文件夹
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Input
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        placeholder="文件夹名称"
                        className="w-40 h-8 text-sm"
                        onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                        autoFocus
                      />
                      <Button size="sm" onClick={handleCreateFolder} disabled={createFolderMutation.isPending}>
                        {createFolderMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '确定'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}>
                        取消
                      </Button>
                    </div>
                  )}
                </>
              )}

              {/* ★ 上传文件（隐藏 input + 触发按钮） */}
              {canWrite && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <Button variant="outline" size="sm" onClick={handleUploadClick}>
                    <Upload className="h-4 w-4 mr-1" /> 上传文件
                  </Button>
                </>
              )}

              {/* 批量删除 */}
              {selectedFileIds.size > 0 && canWrite && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (confirm(`确定删除选中的 ${selectedFileIds.size} 个项目？`)) {
                      selectedFileIds.forEach(id => deleteMutation.mutate(id));
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> 删除 ({selectedFileIds.size})
                </Button>
              )}
            </div>
          </div>

          {/* 文件列表 */}
          {isFilesLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : files.length === 0 ? (
            <div className="text-center py-16 bg-muted/20 rounded-lg border border-dashed">
              <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">工作区暂无文件</p>
              <p className="text-sm text-muted-foreground mt-1">
                {canWrite ? '新建文件夹或上传文件开始协作' : '等待团队成员添加文件'}
              </p>
            </div>
          ) : viewMode === 'list' ? (
            <div className="rounded-lg border overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <div className="col-span-6">
                  <input type="checkbox" disabled className="rounded" />
                  名称
                </div>
                <div className="col-span-1.5">大小</div>
                <div className="col-span-1.5">权限</div>
                <div className="col-span-2">操作</div>
                <div className="col-span-1">日期</div>
              </div>
              {files.map(file => (
                <div
                  key={file.fileId}
                  onDoubleClick={() => {
                    if (file.isFolder) {
                      setCurrentFolderId(file.fileId);
                    } else {
                      setPreviewFile(file);
                      setIsPreviewOpen(true);
                    }
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLInputElement).type !== 'checkbox' &&
                        (e.target as HTMLElement).closest('button') === null) {
                      toggleSelect(file.fileId);
                    }
                    setContextMenuFile(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenuFile(file);
                  }}
                  className={cn(
                    'grid grid-cols-12 gap-2 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors items-center group',
                    selectedFileIds.has(file.fileId) && 'bg-primary/5'
                  )}
                >
                  <div className="col-span-6 flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={selectedFileIds.has(file.fileId)}
                      onChange={() => toggleSelect(file.fileId)}
                      className="rounded"
                      onClick={(e) => e.stopPropagation()}
                    />
                    {file.isFolder ? <FolderOpen className="h-4 w-4 text-blue-500 flex-shrink-0" /> : <File className="h-4 w-4 text-gray-400 flex-shrink-0" />}
                    <span className="truncate">{file.fileName}</span>
                  </div>
                  <div className="col-span-1.5 text-sm text-muted-foreground">
                    {file.isFolder ? '-' : formatBytes(file.size)}
                  </div>
                  <div className="col-span-1.5"><PermissionBadge permission={file.permission} /></div>
                  <div className="col-span-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!file.isFolder && (
                      <>
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); handleDownload(file); }}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); setPreviewFile(file); setIsPreviewOpen(true); }}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                    {canWrite && (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={(e) => { e.stopPropagation();
                          if (confirm(`确定删除「${file.fileName}」？`)) deleteMutation.mutate(file.fileId);
                        }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="col-span-1 text-xs text-muted-foreground">
                    {new Date(file.mountedAt).toLocaleDateString('zh-CN')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {files.map(file => (
                <div
                  key={file.fileId}
                  onDoubleClick={() => {
                    if (file.isFolder) setCurrentFolderId(file.fileId);
                    else { setPreviewFile(file); setIsPreviewOpen(true); }
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button') === null) toggleSelect(file.fileId);
                    setContextMenuFile(null);
                  }}
                  onContextMenu={(e) => { e.preventDefault(); setContextMenuFile(file); }}
                  className={cn(
                    'flex flex-col items-center p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 cursor-pointer transition-colors relative group',
                    selectedFileIds.has(file.fileId) && 'border-primary bg-primary/5'
                  )}
                >
                  {file.isFolder ? <FolderOpen className="h-10 w-10 text-blue-500 mb-2" /> : <File className="h-10 w-10 text-gray-400 mb-2" />}
                  <span className="text-sm text-center truncate w-full">{file.fileName}</span>
                  <PermissionBadge permission={file.permission} />
                  {/* 操作按钮 */}
                  <div className="flex items-center justify-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!file.isFolder && (
                      <>
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); handleDownload(file); }}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); setPreviewFile(file); setIsPreviewOpen(true); }}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ====== 动态 Tab ====== */}
      {activeTab === 'activity' && <TeamActivityFeed teamId={teamId} />}

      {/* 文件预览弹窗 */}
      {isPreviewOpen && previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setIsPreviewOpen(false)}>
          <div className="bg-card rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <File className="h-5 w-5 flex-shrink-0" />
                <span className="font-medium truncate">{previewFile.fileName}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(previewFile.size)}</span>
              </div>
              <button onClick={() => setIsPreviewOpen(false)} className="p-1 rounded hover:bg-muted">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 p-8 overflow-auto flex items-center justify-center bg-muted/20 min-h-[300px]">
              <div className="text-center space-y-3">
                <File className="h-16 w-16 mx-auto text-muted-foreground/30" />
                <p className="text-muted-foreground">此文件类型暂不支持在线预览</p>
                <Button variant="outline" size="sm" onClick={() => { setIsPreviewOpen(false); handleDownload(previewFile!); }}>
                  <Download className="h-4 w-4 mr-1" /> 下载文件
                </Button>
              </div>
            </div>
            <div className="p-4 border-t flex justify-end flex-shrink-0">
              <Button variant="outline" onClick={() => setIsPreviewOpen(false)}>关闭</Button>
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenuFile && (
        <div
          className="fixed z-[100] bg-card rounded-lg shadow-xl border py-1 min-w-[160px]"
          ref={(el) => {
            if (el) {
              el.style.left = `${window.innerWidth / 2}px`;
              el.style.top = `${window.innerHeight / 2}px`;
            }
          }}
        >
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2"
            onClick={() => { setContextMenuFile(null); setPreviewFile(contextMenuFile); setIsPreviewOpen(true); }}
          >
            <Eye className="h-4 w-4" /> 预览
          </button>
          {!contextMenuFile.isFolder && (
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2"
              onClick={() => { setContextMenuFile(null); handleDownload(contextMenuFile); }}
            >
              <Download className="h-4 w-4" /> 下载
            </button>
          )}
          {canWrite && (
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2 text-destructive"
              onClick={() => { setContextMenuFile(null);
                if (confirm(`确定删除「${contextMenuFile.fileName}」？`)) deleteMutation.mutate(contextMenuFile.fileId);
              }}
            >
              <Trash2 className="h-4 w-4" /> 删除
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default TeamWorkspace;
