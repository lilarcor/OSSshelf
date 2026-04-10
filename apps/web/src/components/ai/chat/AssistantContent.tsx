/**
 * AssistantContent.tsx
 * AI助手回复内容渲染组件（优化版）
 *
 * 功能:
 * - Markdown渲染（增强版）
 * - [FILE:id:name] / [FOLDER:id:name] 文件引用解析为可点击元素
 * - 优化的代码块、列表、表格样式
 * - 美观的文件引用按钮设计
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { FolderOpen, FileText, ExternalLink, CheckCircle2 } from 'lucide-react';

interface AssistantContentProps {
  content: string;
  onFileClick: (id: string, isFolder: boolean) => void;
}

const FILE_REF_REGEX = /\[(FILE|FOLDER):([^:]+):([^\]]+)\]/g;

function FileRefButton({
  type,
  id,
  name,
  onClick,
}: {
  type: 'FILE' | 'FOLDER';
  id: string;
  name: string;
  onClick: (id: string, isFolder: boolean) => void;
}) {
  const isFolder = type === 'FOLDER';

  return (
    <button
      onClick={() => onClick(id, isFolder)}
      className="group relative inline-flex items-center gap-2 px-3 py-1.5 mx-0.5 my-1 rounded-xl bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-950/40 dark:to-purple-950/30 border border-violet-200/60 dark:border-violet-700/50 hover:border-violet-400 dark:hover:border-violet-500 hover:from-violet-100 hover:to-purple-100 dark:hover:from-violet-900/50 dark:hover:to-purple-900/40 text-violet-700 dark:text-violet-300 text-[13px] font-medium transition-all duration-200 shadow-sm hover:shadow-md hover:shadow-violet-500/10 active:scale-95"
    >
      <span className="flex items-center justify-center w-5 h-5 rounded-lg bg-white dark:bg-slate-800 shadow-sm">
        {isFolder ? (
          <FolderOpen className="h-3 w-3 text-amber-500" />
        ) : (
          <FileText className="h-3 w-3 text-violet-500" />
        )}
      </span>

      <span className="font-semibold">{name}</span>

      <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-all duration-200 translate-x-[-4px] group-hover:translate-x-0" />

      <CheckCircle2 className="absolute -top-1 -right-1 h-3.5 w-3.5 text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity scale-75 group-hover:scale-100" />
    </button>
  );
}

export function AssistantContent({ content, onFileClick }: AssistantContentProps) {
  const cleanedContent = content.replace(/```tool_call\s*[\s\S]*?```/g, '').trim();

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIndex = 0;

  FILE_REF_REGEX.lastIndex = 0;

  while ((match = FILE_REF_REGEX.exec(cleanedContent)) !== null) {
    if (match.index > lastIndex) {
      const textPart = cleanedContent.slice(lastIndex, match.index);
      parts.push(
        <ReactMarkdown
          key={`md-${keyIndex++}`}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
            h1: ({ children }) => <h1 className="text-xl font-bold mb-4 mt-6 first:mt-0 text-slate-900 dark:text-slate-100 pb-2 border-b border-slate-200 dark:border-slate-700">{children}</h1>,
            h2: ({ children }) => <h2 className="text-lg font-bold mb-3 mt-5 first:mt-0 text-slate-800 dark:text-slate-200">{children}</h2>,
            h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-4 first:mt-0 text-slate-800 dark:text-slate-200">{children}</h3>,
            ul: ({ children }) => <ul className="list-disc list-outside ml-5 mb-3 space-y-1.5 marker:text-violet-400 dark:marker:text-violet-500">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal list-outside ml-5 mb-3 space-y-1.5 marker:text-violet-400 dark:marker:text-violet-500 marker:font-semibold">{children}</ol>,
            li: ({ children }) => <li className="pl-1 leading-relaxed text-slate-700 dark:text-slate-300">{children}</li>,
            code: ({ className, children, ...props }) => {
              const isInline = !className;
              if (isInline) {
                return (
                  <code
                    className="px-1.5 py-0.5 mx-0.5 rounded-md bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-800 dark:to-slate-900 text-violet-600 dark:text-violet-400 text-[13px] font-mono font-medium border border-slate-200/60 dark:border-slate-700/50"
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            pre: ({ children }) => (
              <div className="relative group/my-3 mb-4 last:mb-0">
                <pre className="relative overflow-x-auto rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 p-4 text-[13px] leading-relaxed border border-slate-700/50 shadow-lg shadow-slate-900/20">
                  {children}
                </pre>
                <div className="absolute top-2 right-2 opacity-0 group-hover/my:opacity-100 transition-opacity">
                  <button
                    onClick={() => navigator.clipboard.writeText(children?.toString() || '')}
                    className="p-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-600 text-slate-300 text-xs transition-colors"
                  >
                    复制
                  </button>
                </div>
              </div>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-violet-400 dark:border-violet-500 pl-4 py-2 my-3 bg-gradient-to-r from-violet-50/50 to-transparent dark:from-violet-950/20 rounded-r-lg italic text-slate-600 dark:text-slate-400">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <table className="w-full text-sm">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-900 border-b border-slate-200 dark:border-slate-700">
                {children}
              </thead>
            ),
            th: ({ children }) => (
              <th className="px-4 py-2.5 text-left font-semibold text-slate-700 dark:text-slate-300 text-xs uppercase tracking-wider">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                {children}
              </td>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-600 dark:text-violet-400 underline decoration-violet-300 dark:decoration-violet-600 underline-offset-2 hover:decoration-violet-500 dark:hover:decoration-violet-400 transition-colors font-medium"
              >
                {children}
              </a>
            ),
            strong: ({ children }) => <strong className="font-bold text-slate-900 dark:text-slate-100">{children}</strong>,
            em: ({ children }) => <em className="italic text-slate-700 dark:text-slate-300">{children}</em>,
            hr: () => <hr className="my-6 border-t-2 border-slate-200 dark:border-slate-700" />,
            img: ({ src, alt }) => (
              <img
                src={src}
                alt={alt || ''}
                className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-md max-w-full my-4"
                loading="lazy"
              />
            ),
          }}
        >
          {textPart}
        </ReactMarkdown>
      );
    }

    const type = match[1] as 'FILE' | 'FOLDER';
    const id = match[2] ?? '';
    const name = match[3] ?? '';
    parts.push(<FileRefButton key={`ref-${keyIndex++}`} type={type} id={id} name={name} onClick={onFileClick} />);

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleanedContent.length) {
    const textPart = cleanedContent.slice(lastIndex);
    parts.push(
      <ReactMarkdown
        key={`md-${keyIndex++}`}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
          h1: ({ children }) => <h1 className="text-xl font-bold mb-4 mt-6 first:mt-0 text-slate-900 dark:text-slate-100 pb-2 border-b border-slate-200 dark:border-slate-700">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-bold mb-3 mt-5 first:mt-0 text-slate-800 dark:text-slate-200">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-4 first:mt-0 text-slate-800 dark:text-slate-200">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc list-outside ml-5 mb-3 space-y-1.5 marker:text-violet-400 dark:marker:text-violet-500">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-outside ml-5 mb-3 space-y-1.5 marker:text-violet-400 dark:marker:text-violet-500 marker:font-semibold">{children}</ol>,
          li: ({ children }) => <li className="pl-1 leading-relaxed text-slate-700 dark:text-slate-300">{children}</li>,
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 mx-0.5 rounded-md bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-800 dark:to-slate-900 text-violet-600 dark:text-violet-400 text-[13px] font-mono font-medium border border-slate-200/60 dark:border-slate-700/50"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <div className="relative group/my-3 mb-4 last:mb-0">
              <pre className="relative overflow-x-auto rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 p-4 text-[13px] leading-relaxed border border-slate-700/50 shadow-lg shadow-slate-900/20">
                {children}
              </pre>
              <div className="absolute top-2 right-2 opacity-0 group-hover/my:opacity-100 transition-opacity">
                <button
                  onClick={() => navigator.clipboard.writeText(children?.toString() || '')}
                  className="p-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-600 text-slate-300 text-xs transition-colors"
                >
                  复制
                </button>
              </div>
            </div>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-violet-400 dark:border-violet-500 pl-4 py-2 my-3 bg-gradient-to-r from-violet-50/50 to-transparent dark:from-violet-950/20 rounded-r-lg italic text-slate-600 dark:text-slate-400">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-900 border-b border-slate-200 dark:border-slate-700">
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className="px-4 py-2.5 text-left font-semibold text-slate-700 dark:text-slate-300 text-xs uppercase tracking-wider">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-400">
              {children}
            </td>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-600 dark:text-violet-400 underline decoration-violet-300 dark:decoration-violet-600 underline-offset-2 hover:decoration-violet-500 dark:hover:decoration-violet-400 transition-colors font-medium"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-bold text-slate-900 dark:text-slate-100">{children}</strong>,
          em: ({ children }) => <em className="italic text-slate-700 dark:text-slate-300">{children}</em>,
          hr: () => <hr className="my-6 border-t-2 border-slate-200 dark:border-slate-700" />,
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt || ''}
              className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-md max-w-full my-4"
              loading="lazy"
            />
          ),
        }}
      >
        {textPart}
      </ReactMarkdown>
    );
  }

  if (parts.length === 0) {
    return (
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
            h1: ({ children }) => <h1 className="text-xl font-bold mb-4 mt-6 first:mt-0 text-slate-900 dark:text-slate-100 pb-2 border-b border-slate-200 dark:border-slate-700">{children}</h1>,
            h2: ({ children }) => <h2 className="text-lg font-bold mb-3 mt-5 first:mt-0 text-slate-800 dark:text-slate-200">{children}</h2>,
            h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-4 first:mt-0 text-slate-800 dark:text-slate-200">{children}</h3>,
            ul: ({ children }) => <ul className="list-disc list-outside ml-5 mb-3 space-y-1.5 marker:text-violet-400 dark:marker:text-violet-500">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal list-outside ml-5 mb-3 space-y-1.5 marker:text-violet-400 dark:marker:text-violet-500 marker:font-semibold">{children}</ol>,
            li: ({ children }) => <li className="pl-1 leading-relaxed text-slate-700 dark:text-slate-300">{children}</li>,
            code: ({ className, children, ...props }) => {
              const isInline = !className;
              if (isInline) {
                return (
                  <code
                    className="px-1.5 py-0.5 mx-0.5 rounded-md bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-800 dark:to-slate-900 text-violet-600 dark:text-violet-400 text-[13px] font-mono font-medium border border-slate-200/60 dark:border-slate-700/50"
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            pre: ({ children }) => (
              <div className="relative group/my-3 mb-4 last:mb-0">
                <pre className="relative overflow-x-auto rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 p-4 text-[13px] leading-relaxed border border-slate-700/50 shadow-lg shadow-slate-900/20">
                  {children}
                </pre>
                <div className="absolute top-2 right-2 opacity-0 group-hover/my:opacity-100 transition-opacity">
                  <button
                    onClick={() => navigator.clipboard.writeText(children?.toString() || '')}
                    className="p-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-600 text-slate-300 text-xs transition-colors"
                  >
                    复制
                  </button>
                </div>
              </div>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-violet-400 dark:border-violet-500 pl-4 py-2 my-3 bg-gradient-to-r from-violet-50/50 to-transparent dark:from-violet-950/20 rounded-r-lg italic text-slate-600 dark:text-slate-400">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <table className="w-full text-sm">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-900 border-b border-slate-200 dark:border-slate-700">
                {children}
              </thead>
            ),
            th: ({ children }) => (
              <th className="px-4 py-2.5 text-left font-semibold text-slate-700 dark:text-slate-300 text-xs uppercase tracking-wider">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                {children}
              </td>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-600 dark:text-violet-400 underline decoration-violet-300 dark:decoration-violet-600 underline-offset-2 hover:decoration-violet-500 dark:hover:decoration-violet-400 transition-colors font-medium"
              >
                {children}
              </a>
            ),
            strong: ({ children }) => <strong className="font-bold text-slate-900 dark:text-slate-100">{children}</strong>,
            em: ({ children }) => <em className="italic text-slate-700 dark:text-slate-300">{children}</em>,
            hr: () => <hr className="my-6 border-t-2 border-slate-200 dark:border-slate-700" />,
            img: ({ src, alt }) => (
              <img
                src={src}
                alt={alt || ''}
                className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-md max-w-full my-4"
                loading="lazy"
              />
            ),
          }}
        >
          {cleanedContent}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert space-y-1">
      {parts}
    </div>
  );
}
