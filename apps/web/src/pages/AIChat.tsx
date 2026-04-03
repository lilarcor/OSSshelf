/**
 * AIChat.tsx
 * AI 智能问答页面
 */

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  MessageSquare, 
  Send, 
  Loader2, 
  FileText, 
  Image, 
  File,
  Sparkles,
  ArrowLeft,
  Trash2,
  ExternalLink
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { aiApi } from '@/services/api';
import { formatDate } from '@/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{
    id: string;
    name: string;
    mimeType: string | null;
    score: number;
  }>;
  timestamp: Date;
}

export function AIChat() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await aiApi.chat(input.trim(), { limit: 5 });
      
      if (response.data.success && response.data.data) {
        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.data.data.answer,
          sources: response.data.data.sources,
          timestamp: new Date()
        };
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        throw new Error('Failed to get response');
      }
    } catch (error) {
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '抱歉，我遇到了一些问题，无法回答您的问题。请稍后再试。',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = () => {
    setMessages([]);
  };

  const handleFileClick = (fileId: string) => {
    navigate(`/files?highlight=${fileId}`);
  };

  const getFileIcon = (mimeType: string | null) => {
    if (!mimeType) return <File className="h-4 w-4" />;
    if (mimeType.startsWith('image/')) return <Image className="h-4 w-4" />;
    if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml')) {
      return <FileText className="h-4 w-4" />;
    }
    return <File className="h-4 w-4" />;
  };

  const suggestedQuestions = [
    "帮我找一下最近上传的文档",
    "有哪些关于项目的文件？",
    "搜索包含'设计'的图片",
    "帮我整理一下技术文档"
  ];

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-gradient-to-br from-slate-50 via-white to-purple-50 dark:from-slate-950 dark:via-slate-900 dark:to-purple-950">
      <div className="border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/settings')}
              className="mr-2"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              <div className="p-2 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-semibold">AI 智能问答</h1>
                <p className="text-xs text-muted-foreground">基于您的文件进行智能问答</p>
              </div>
            </div>
          </div>
          
          {messages.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleClear}>
              <Trash2 className="h-4 w-4 mr-2" />
              清空对话
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
              <div className="p-4 bg-gradient-to-br from-purple-500 to-pink-500 rounded-2xl mb-6">
                <MessageSquare className="h-12 w-12 text-white" />
              </div>
              <h2 className="text-2xl font-bold mb-2">开始与AI对话</h2>
              <p className="text-muted-foreground mb-8 max-w-md">
                基于您的文件进行智能问答，AI会自动检索相关文件并生成答案
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-lg">
                {suggestedQuestions.map((question, idx) => (
                  <button
                    key={idx}
                    onClick={() => setInput(question)}
                    className="p-4 text-left border rounded-lg hover:bg-accent transition-colors text-sm"
                  >
                    <Sparkles className="h-4 w-4 mb-2 text-purple-500" />
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] ${
                  message.role === 'user'
                    ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-2xl rounded-br-md'
                    : 'bg-white dark:bg-slate-800 border rounded-2xl rounded-bl-md'
                } px-4 py-3 shadow-sm`}
              >
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {message.content}
                </div>
                
                {message.sources && message.sources.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-xs text-muted-foreground mb-2">参考文件：</p>
                    <div className="space-y-1">
                      {message.sources.map((source, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleFileClick(source.id)}
                          className="flex items-center gap-2 w-full p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-left"
                        >
                          <div className="flex-shrink-0 text-muted-foreground">
                            {getFileIcon(source.mimeType)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{source.name}</p>
                            <p className="text-xs text-muted-foreground">
                              相关度: {(source.score * 100).toFixed(0)}%
                            </p>
                          </div>
                          <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                <div className={`text-xs mt-2 ${message.role === 'user' ? 'text-white/70' : 'text-muted-foreground'}`}>
                  {formatDate(message.timestamp.toISOString())}
                </div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white dark:bg-slate-800 border rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
                  <span className="text-sm text-muted-foreground">正在思考...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="输入您的问题，AI会基于您的文件进行回答..."
                className="w-full resize-none rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                rows={1}
                style={{
                  minHeight: '48px',
                  maxHeight: '120px'
                }}
                disabled={isLoading}
              />
            </div>
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl px-6"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            AI会自动检索您的文件并生成答案 · 按 Enter 发送，Shift+Enter 换行
          </p>
        </div>
      </div>
    </div>
  );
}
