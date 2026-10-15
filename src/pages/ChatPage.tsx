import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from 'tdesign-react';
import { Feather, Anchor, Sparkles, Loader2 } from 'lucide-react';
import { Model, Session, PermissionMode, CustomAgent, PermissionRequest } from '../types';
import { NovelWorkbench } from '../components/NovelWorkbench';
import { ChatMessages } from '../components/ChatMessages';
import { ChatInput } from '../components/ChatInput';
import type { useNovel } from '../hooks/useNovel';

interface ChatPageProps {
  currentSession: Session | undefined;
  models: Model[];
  selectedModel: string;
  agents: CustomAgent[];
  isLoading: boolean;
  inputValue: string;
  permissionRequest: PermissionRequest | null;
  permissionMode: PermissionMode;
  onSendMessage: (message: string, newChatOptions?: NewChatOptions, onNavigate?: (path: string) => void) => void;
  onStop: () => void;
  onInputChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onPermissionAllow: () => void;
  onPermissionDeny: () => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** 小说工程 */
  novel: ReturnType<typeof useNovel>;
  onWriteNext: () => void;
  isWriting: boolean;
  /** 存稿阶段文案（降味 / 回收 / 质检），由服务端推进来 */
  writePhase?: string;
}

interface NewChatOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
}

export function ChatPage({
  currentSession,
  models,
  selectedModel,
  agents,
  isLoading,
  inputValue,
  permissionRequest,
  permissionMode,
  onSendMessage,
  onStop,
  onInputChange,
  onModelChange,
  onPermissionAllow,
  onPermissionDeny,
  onPermissionModeChange,
  novel,
  onWriteNext,
  isWriting,
  writePhase,
}: ChatPageProps) {
  const navigate = useNavigate();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 新对话页面状态
  const [newChatAgentId, setNewChatAgentId] = useState('default');
  const [newChatCwd, setNewChatCwd] = useState('');

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  // 处理发送消息
  const handleSend = useCallback((message: string) => {
    if (!currentSession) {
      // 新对话
      onSendMessage(message, {
        agentId: newChatAgentId,
        cwd: newChatCwd,
        permissionMode: permissionMode,
      }, (path) => {
        navigate(path);
      });
    } else {
      onSendMessage(message);
    }
  }, [currentSession, newChatAgentId, newChatCwd, permissionMode, onSendMessage, navigate]);

  const showNewChatView = !currentSession || currentSession.messages.length === 0;
  const summary = novel.summary;

  return (
    <>
      {/* 消息区域 */}
      <div className="flex-1 overflow-y-auto p-6">
        {showNewChatView ? (
          <NovelWorkbench
            novel={novel}
            onWriteNext={onWriteNext}
            isWriting={isWriting}
            agents={agents}
            selectedAgentId={newChatAgentId}
            onSelectAgent={setNewChatAgentId}
            cwd={newChatCwd}
            onSetCwd={setNewChatCwd}
          />
        ) : (
          <ChatMessages
            messages={currentSession!.messages}
            models={models}
            messagesEndRef={messagesEndRef}
            permissionRequest={permissionRequest}
            onPermissionAllow={onPermissionAllow}
            onPermissionDeny={onPermissionDeny}
          />
        )}
      </div>

      {/* 小说状态条：聊天过程中也能看到进度 + 一键续写 */}
      {novel.hasProject && summary && (
        <div
          className="px-6 py-2 flex items-center gap-3 text-xs border-t"
          style={{ borderColor: 'var(--td-component-stroke)', backgroundColor: 'var(--td-bg-color-container)' }}
        >
          <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
            <Feather size={13} style={{ color: '#7c3aed' }} />
            《{summary.title}》
          </span>
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>
            第 {summary.currentChapter} 章 · 已写 {summary.stats.chapters} 章 / {summary.stats.words} 字
          </span>
          <span className="inline-flex items-center gap-1" style={{ color: summary.health?.overdueHooks ? '#ea580c' : 'var(--td-text-color-placeholder)' }}>
            <Anchor size={12} />
            坑 {summary.health?.openHooks ?? 0} 开 / {summary.health?.closedHooks ?? 0} 收
            {(summary.health?.overdueHooks ?? 0) > 0 ? ` / ${summary.health?.overdueHooks} 拖太久` : ''}
          </span>
          <div className="flex-1" />
          {isWriting && writePhase && (
            <span className="inline-flex items-center gap-1.5 truncate max-w-[42%]" style={{ color: '#7c3aed' }}>
              <Loader2 size={12} className="animate-spin shrink-0" />
              {writePhase}
            </span>
          )}
          <Button size="small" theme="primary" variant="outline" onClick={onWriteNext} loading={isWriting} disabled={isWriting}>
            <span className="inline-flex items-center gap-1">
              <Sparkles size={12} /> 续写第 {summary.currentChapter} 章
            </span>
          </Button>
        </div>
      )}

      {/* 输入区域 */}
      <ChatInput
        inputValue={inputValue}
        selectedModel={selectedModel}
        models={models}
        isLoading={isLoading}
        permissionMode={permissionMode}
        onSend={handleSend}
        onStop={onStop}
        onChange={onInputChange}
        onModelChange={onModelChange}
        onPermissionModeChange={onPermissionModeChange}
      />
    </>
  );
}
