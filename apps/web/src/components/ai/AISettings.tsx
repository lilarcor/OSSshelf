/**
 * AISettings.tsx
 * AI 功能设置页面
 */

import { useState, useEffect } from 'react';
import { 
  Sparkles, 
  Database, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Loader2, 
  Square,
  FileText,
  Image,
  File,
  Play,
  MessageSquare
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { aiApi } from '@/services/api';
import type { AIIndexTask, AISummarizeTask, AITagsTask, AIIndexStats } from '@/services/api';
import { formatDate } from '@/utils';
import { useNavigate } from 'react-router-dom';

export function AISettings() {
  const navigate = useNavigate();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [task, setTask] = useState<AIIndexTask | null>(null);
  const [summarizeTask, setSummarizeTask] = useState<AISummarizeTask | null>(null);
  const [tagsTask, setTagsTask] = useState<AITagsTask | null>(null);
  const [stats, setStats] = useState<AIIndexStats | null>(null);
  const [aiStatus, setAiStatus] = useState<{ configured: boolean; features: Record<string, boolean> } | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isStartingSummarize, setIsStartingSummarize] = useState(false);
  const [isStartingTags, setIsStartingTags] = useState(false);
  const [showIndexWarning, setShowIndexWarning] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchAllTaskStatus();
    fetchStats();
    
    const interval = setInterval(() => {
      fetchAllTaskStatus();
      fetchStats();
    }, 5000);
    
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await aiApi.getStatus();
      if (response.data.success && response.data.data) {
        setAiStatus(response.data.data);
      }
    } catch (error) {
      console.error('Failed to fetch AI status:', error);
    }
  };

  const fetchAllTaskStatus = async () => {
    try {
      const [indexRes, summarizeRes, tagsRes] = await Promise.all([
        aiApi.getIndexStatus(),
        aiApi.getSummarizeTask(),
        aiApi.getTagsTask()
      ]);
      
      if (indexRes.data.success && indexRes.data.data) {
        setTask(indexRes.data.data);
      }
      if (summarizeRes.data.success && summarizeRes.data.data) {
        setSummarizeTask(summarizeRes.data.data);
      }
      if (tagsRes.data.success && tagsRes.data.data) {
        setTagsTask(tagsRes.data.data);
      }
    } catch (error) {
      console.error('Failed to fetch task status:', error);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await aiApi.getIndexStats();
      if (response.data.success && response.data.data) {
        setStats(response.data.data);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  };

  const handleStartSummarize = async () => {
    setIsStartingSummarize(true);
    try {
      const response = await aiApi.summarizeBatch();
      if (response.data.success && response.data.data) {
        setSummarizeTask(response.data.data.task);
      }
    } catch (e: any) {
      console.error('Failed to start summarize:', e);
    } finally {
      setIsStartingSummarize(false);
    }
  };

  const handleStartTags = async () => {
    setIsStartingTags(true);
    try {
      const response = await aiApi.tagsBatch();
      if (response.data.success && response.data.data) {
        setTagsTask(response.data.data.task);
      }
    } catch (e: any) {
      console.error('Failed to start tags:', e);
    } finally {
      setIsStartingTags(false);
    }
  };

  const handleStartIndex = async () => {
    if (stats && (stats.editable.noSummary > 0 || stats.image.noTags > 0)) {
      setShowIndexWarning(true);
      return;
    }
    
    await executeStartIndex();
  };

  const executeStartIndex = async () => {
    setIsStarting(true);
    setShowIndexWarning(false);
    setShowConfirmDialog(false);
    try {
      const response = await aiApi.indexAll();
      if (response.data.success && response.data.data) {
        setTask(response.data.data.task);
      }
    } catch (e: any) {
      console.error('Failed to start index:', e);
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancelTask = async () => {
    try {
      const response = await aiApi.cancelIndexTask();
      if (response.data.success && response.data.data) {
        setTask(response.data.data.task);
      }
    } catch (e: any) {
      console.error('Failed to cancel task:', e);
    }
  };

  const renderTaskProgress = (
    taskData: AIIndexTask | AISummarizeTask | AITagsTask | null,
    onCancel?: () => void
  ) => {
    if (!taskData || taskData.status === 'idle') {
      return null;
    }

    const progress = taskData.total > 0 ? (taskData.processed / taskData.total) * 100 : 0;

    return (
      <div className="space-y-2 mt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {taskData.status === 'running' && (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
                <span className="text-sm font-medium">处理中...</span>
              </>
            )}
            {taskData.status === 'completed' && (
              <>
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span className="text-sm font-medium">已完成</span>
              </>
            )}
            {taskData.status === 'failed' && (
              <>
                <XCircle className="h-4 w-4 text-red-500" />
                <span className="text-sm font-medium">失败</span>
              </>
            )}
            {taskData.status === 'cancelled' && (
              <>
                <Square className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-medium">已取消</span>
              </>
            )}
          </div>
          {onCancel && (taskData.status === 'running' || taskData.status === 'cancelled') && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              {taskData.status === 'running' ? '取消' : '清除'}
            </Button>
          )}
        </div>

        <div className="w-full bg-secondary rounded-full h-2">
          <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>

        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            进度: {taskData.processed} / {taskData.total}
          </span>
          {taskData.failed > 0 && <span className="text-red-500">失败: {taskData.failed}</span>}
        </div>
      </div>
    );
  };

  const renderStatsCard = (
    title: string,
    icon: React.ReactNode,
    total: number,
    items: Array<{ label: string; count: number; color?: string }>,
    actionButton?: React.ReactNode
  ) => (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h4 className="font-medium">{title}</h4>
        </div>
        <span className="text-2xl font-bold">{total}</span>
      </div>
      
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{item.label}</span>
            <span className={`font-medium ${item.color || ''}`}>{item.count}</span>
          </div>
        ))}
      </div>

      {actionButton}
    </div>
  );

  const isAIAvailable = aiStatus?.configured;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h3 className="text-xl font-semibold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-purple-500" />
            AI 功能中心
          </h3>
          <p className="text-sm text-muted-foreground">管理AI处理任务，提升文件搜索与分析能力</p>
        </div>
        
        <Button
          variant="outline"
          onClick={() => navigate('/ai-chat')}
          className="flex items-center gap-2"
        >
          <MessageSquare className="h-4 w-4" />
          AI问答
        </Button>
      </div>

      {!isAIAvailable && (
        <div className="border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 rounded-lg p-4">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">AI 功能未配置</p>
          <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
            请在 Cloudflare Dashboard 中配置 AI 和 Vectorize 绑定
          </p>
        </div>
      )}

      {isAIAvailable && (
        <>
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">💡 建议处理顺序</p>
            <ol className="text-sm text-blue-700 dark:text-blue-300 space-y-1 list-decimal list-inside">
              <li>批量生成可编辑文件摘要（提升文本文件语义理解）</li>
              <li>批量生成图片标签+描述（增强图片搜索能力）</li>
              <li>执行一键索引（建立完整向量索引）</li>
            </ol>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {renderStatsCard(
              '可编辑文件',
              <FileText className="h-5 w-5 text-blue-500" />,
              stats?.editable.total || 0,
              [
                { label: '未生成摘要', count: stats?.editable.noSummary || 0, color: 'text-amber-600' },
                { label: '未索引', count: stats?.editable.notIndexed || 0, color: 'text-red-600' }
              ],
              <div className="pt-3 border-t mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleStartSummarize}
                  disabled={isStartingSummarize || summarizeTask?.status === 'running'}
                >
                  {isStartingSummarize || summarizeTask?.status === 'running' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      处理中...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      批量生成摘要
                    </>
                  )}
                </Button>
                {renderTaskProgress(summarizeTask)}
              </div>
            )}

            {renderStatsCard(
              '图片文件',
              <Image className="h-5 w-5 text-green-500" />,
              stats?.image.total || 0,
              [
                { label: '未生成标签', count: stats?.image.noTags || 0, color: 'text-amber-600' },
                { label: '未索引', count: stats?.image.notIndexed || 0, color: 'text-red-600' }
              ],
              <div className="pt-3 border-t mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleStartTags}
                  disabled={isStartingTags || tagsTask?.status === 'running'}
                >
                  {isStartingTags || tagsTask?.status === 'running' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      处理中...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      批量生成标签
                    </>
                  )}
                </Button>
                {renderTaskProgress(tagsTask)}
              </div>
            )}

            {renderStatsCard(
              '其他文件',
              <File className="h-5 w-5 text-gray-500" />,
              stats?.other.total || 0,
              [
                { label: '未索引', count: stats?.other.notIndexed || 0, color: 'text-red-600' }
              ]
            )}
          </div>

          <div className="border rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium flex items-center gap-2">
                  <Database className="h-5 w-5" />
                  语义搜索索引
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  为所有文件建立向量索引，支持智能语义搜索
                </p>
              </div>
              <Button
                variant="default"
                onClick={() => setShowConfirmDialog(true)}
                disabled={task?.status === 'running'}
              >
                <Database className="h-4 w-4 mr-2" />
                一键生成索引
              </Button>
            </div>

            {renderTaskProgress(task, handleCancelTask)}
          </div>
        </>
      )}

      {showConfirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowConfirmDialog(false)} />
          <div className="relative bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              <h4 className="font-semibold">确认生成全量索引</h4>
            </div>

            <div className="space-y-3 text-sm">
              <p>此操作将为所有未建立索引的文件生成向量索引，用于语义搜索功能。</p>
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-2">
                <p className="font-medium text-amber-800 dark:text-amber-200">⚠️ 重要提示：</p>
                <ul className="text-amber-700 dark:text-amber-300 space-y-1 list-disc list-inside">
                  <li>此操作将处理您的所有文件数据</li>
                  <li>任务将在后台异步执行，可能需要较长时间</li>
                  <li>大量文件可能消耗 AI API 配额</li>
                  <li>索引期间可随时查看进度</li>
                </ul>
              </div>
              <p className="text-muted-foreground">确认后，系统将在后台自动处理所有文件，您可以继续使用其他功能。</p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
                取消
              </Button>
              <Button onClick={handleStartIndex} disabled={isStarting}>
                {isStarting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                确认开始
              </Button>
            </div>
          </div>
        </div>
      )}

      {showIndexWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowIndexWarning(false)} />
          <div className="relative bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              <h4 className="font-semibold">建议先完成预处理</h4>
            </div>

            <div className="space-y-3 text-sm">
              <p>检测到以下文件尚未完成AI预处理，直接索引可能影响搜索质量：</p>
              
              <div className="space-y-2">
                {stats?.editable.noSummary && stats.editable.noSummary > 0 && (
                  <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                    <p className="font-medium text-amber-800 dark:text-amber-200">
                      📄 {stats.editable.noSummary} 个可编辑文件未生成摘要
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                      建议先批量生成摘要，提升语义理解质量
                    </p>
                  </div>
                )}
                
                {stats?.image.noTags && stats.image.noTags > 0 && (
                  <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                    <p className="font-medium text-amber-800 dark:text-amber-200">
                      🖼️ {stats.image.noTags} 个图片未生成标签
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                      建议先批量生成标签，增强图片搜索能力
                    </p>
                  </div>
                )}
              </div>

              <p className="text-muted-foreground">
                您也可以选择直接索引，系统将使用文件名作为索引内容。
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowIndexWarning(false)}>
                返回处理
              </Button>
              <Button onClick={executeStartIndex} disabled={isStarting}>
                {isStarting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                直接索引
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
