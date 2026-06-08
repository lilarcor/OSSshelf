/**
 * TeamWorkspace.tsx — 团队工作区文件浏览器
 *
 * 核心差异化组件：提供独立的团队文件浏览视图
 * - 显示团队所有已挂载资源的聚合视图
 * - 每个文件标注权限级别
 * - 支持 list/grid 视图切换
 * - Tab 切换：文件列表 / 动态时间线
 */

import React, { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/useToast';
import { teamsApi, type WorkspaceFile } from '@/services/collab';
import {
  ArrowLeft,
  FolderOpen,
  File,
  HardDrive,
  Users,
  Loader2,
  Grid,
  List,
  RefreshCw,
  Lock,
  Edit,
  Crown,
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
  const navigate = useNavigate();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('files');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const { data: filesData, isLoading: isFilesLoading, refetch: refetchFiles } = useQuery({
    queryKey: ['team-workspace-files', teamId],
    queryFn: () =>
      teamsApi.getWorkspaceFiles(teamId, { limit: 100 }).then((r) => r.data.data),
  });

  const { data: storageData } = useQuery({
    queryKey: ['team-storage', teamId],
    queryFn: () => teamsApi.getStorageStats(teamId).then((r) => r.data.data),
  });

  const files = filesData?.files ?? [];
  const total = filesData?.total ?? 0;

  const handleFolderClick = useCallback((file: WorkspaceFile) => {
    if (file.isFolder && file.permission !== 'read') {
      toast({ title: '文件夹导航：即将推出', variant: 'default' });
    }
  }, [toast]);

  const PermissionBadge = ({ permission }: { permission: string }) => {
    if (permission === 'admin') return <Crown className="h-3.5 w-3.5 text-purple-500" />;
    if (permission === 'write') return <Edit className="h-3.5 w-3.5 text-blue-500" />;
    return <Lock className="h-3.5 w-3.5 text-gray-400" />;
  };

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/teams')} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="返回">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">{teamName}</h2>
              <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full flex items-center gap-1">
                <Users className="h-3 w-3" /> 工作区
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">团队 / {teamName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {storageData && (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <HardDrive className="h-3.5 w-3.5" /> {storageData.usagePercent}%
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={() => refetchFiles()} title="刷新">
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
        ]).map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={cn(
            'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            activeTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}>
            {tab.icon} {tab.label} {tab.key === 'files' && ` (${total})`}
          </button>
        ))}
      </div>

      {/* 文件 Tab */}
      {activeTab === 'files' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Button variant={viewMode === 'list' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('list')}>
                <List className="h-4 w-4" />
              </Button>
              <Button variant={viewMode === 'grid' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('grid')}>
                <Grid className="h-4 w-4" />
              </Button>
            </div>
            {(userRole === 'admin' || userRole === 'owner' || isOwner) && (
              <Button size="sm" disabled title="即将支持直接上传到工作区">
                上传文件
              </Button>
            )}
          </div>

          {isFilesLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
          ) : files.length === 0 ? (
            <div className="text-center py-16 bg-muted/20 rounded-lg border border-dashed">
              <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">工作区暂无文件</p>
              <p className="text-sm text-muted-foreground mt-1">团队管理员可从个人空间挂载文件到这里</p>
            </div>
          ) : viewMode === 'list' ? (
            <div className="rounded-lg border overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <div className="col-span-6">名称</div><div className="col-span-2">大小</div>
                <div className="col-span-2">权限</div><div className="col-span-2">挂载时间</div>
              </div>
              {files.map((file) => (
                <div key={file.fileId} onClick={() => handleFolderClick(file)}
                  className="grid grid-cols-12 gap-2 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors items-center"
                >
                  <div className="col-span-6 flex items-center gap-2 min-w-0">
                    {file.isFolder ? <FolderOpen className="h-4 w-4 text-blue-500 flex-shrink-0" /> : <File className="h-4 w-4 text-gray-400 flex-shrink-0" />}
                    <span className="truncate">{file.fileName}</span>
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">{file.isFolder ? '-' : formatBytes(file.size)}</div>
                  <div className="col-span-2"><PermissionBadge permission={file.permission} /></div>
                  <div className="col-span-2 text-xs text-muted-foreground">{new Date(file.mountedAt).toLocaleDateString('zh-CN')}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {files.map((file) => (
                <div key={file.fileId} onClick={() => handleFolderClick(file)}
                  className="flex flex-col items-center p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 cursor-pointer transition-colors"
                >
                  {file.isFolder ? <FolderOpen className="h-10 w-10 text-blue-500 mb-2" /> : <File className="h-10 w-10 text-gray-400 mb-2" />}
                  <span className="text-sm text-center truncate w-full">{file.fileName}</span>
                  <PermissionBadge permission={file.permission} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 动态 Tab */}
      {activeTab === 'activity' && <TeamActivityFeed teamId={teamId} />}
    </div>
  );
};

export default TeamWorkspace;
