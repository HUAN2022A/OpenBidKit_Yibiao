import { useCallback, useEffect, useRef, useState } from 'react';
import { AppSwitch, MarkdownEditor, MarkdownRenderer, useToast } from '../../../shared/ui';

/**
 * 正文内容编辑器（标书提质 · bid-improvement）。
 *
 * 职责：
 * - 用 shared/ui 的 MarkdownEditor 编辑某个目录节点的正文；
 * - 编辑时自动保存（去抖），通过 IPC 把节点内容写回 Main；
 * - 展示节点标题与层级；
 * - 提供「只读」开关，查看模式下禁用编辑并渲染预览。
 *
 * 依赖的 IPC 契约（已在 preload / ipc.ts 声明）：
 *   window.yibiao.bidImprovement.updateNodeContent(
 *     nodeId: string,       // 目录节点 ID
 *     content: string,      // 节点正文（Markdown）
 *   ) => Promise<{ success: boolean }>
 */

export interface ContentEditorNode {
  id: string;
  title: string;
  /** 目录层级（对应 Markdown 标题级别 1-6） */
  level: number;
  content?: string;
  children?: ContentEditorNode[];
}

export interface ContentEditorSavedPayload {
  documentId: string;
  nodeId: string;
  content: string;
}

export interface ContentEditorProps {
  /** 当前编辑的目录节点；为 null 时显示空状态 */
  node: ContentEditorNode | null;
  /** 所属标书文档 ID，随自动保存一起传给 Main */
  documentId: string;
  /** 是否只读（查看模式）；为 true 时禁用编辑并显示预览 */
  readOnly?: boolean;
  /** 自动保存成功后的回调，便于父组件同步本地状态 */
  onContentSaved?: (payload: ContentEditorSavedPayload) => void;
}

/** 自动保存去抖延迟（毫秒） */
const AUTOSAVE_DELAY_MS = 500;

export default function ContentEditor({ node, documentId, readOnly = false, onContentSaved }: ContentEditorProps) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState('');
  const [viewOnly, setViewOnly] = useState(Boolean(readOnly));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSaveRef = useRef(false);
  const saveTokenRef = useRef(0);

  // 切换节点或外部内容变化时，重置草稿并跳过本次自动保存。
  useEffect(() => {
    setDraft(String(node?.content ?? ''));
    setSavedAt(null);
    skipNextSaveRef.current = true;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, [node?.id, node?.content]);

  // 父组件 readOnly 变化时同步内部查看模式。
  useEffect(() => {
    setViewOnly(Boolean(readOnly));
  }, [readOnly]);

  const persistContent = useCallback(
    async (nodeId: string, content: string, token: number) => {
      try {
        const result = await window.yibiao.bidImprovement.updateNodeContent(nodeId, content);
        if (result && result.success === false) {
          throw new Error('保存失败');
        }
        if (saveTokenRef.current === token) {
          setSaving(false);
          setSavedAt(Date.now());
        }
        onContentSaved?.({ documentId, nodeId, content });
      } catch (error) {
        if (saveTokenRef.current === token) {
          setSaving(false);
        }
        showToast(error instanceof Error ? error.message : '保存失败', 'error');
      }
    },
    [documentId, onContentSaved, showToast],
  );

  // 草稿变化后延迟自动保存（去抖），避免每次按键都触发一次 IPC。
  useEffect(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (!node || !documentId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const token = ++saveTokenRef.current;
    setSaving(true);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistContent(node.id, draft, token);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [draft, node?.id, documentId, persistContent]);

  if (!node) {
    return (
      <div className="bid-improvement-content-editor">
        <div className="markdown-empty-state content-editor-empty">
          <strong>未选择正文小节</strong>
          <p>请先在左侧目录中选择一个正文小节。</p>
        </div>
      </div>
    );
  }

  const levelLabel = `第 ${node.level} 级`;

  return (
    <div className="bid-improvement-content-editor">
      <header className="bid-improvement-content-editor-head">
        <div>
          <span className="section-kicker">正文内容</span>
          <strong>{node.title || '未命名小节'}</strong>
          <p>
            <span className="bid-improvement-content-editor-level" title={`层级 ${node.level}`}>
              {levelLabel}
            </span>
          </p>
        </div>
        <div className="bid-improvement-content-editor-actions">
          <span className="bid-improvement-content-editor-save-state" aria-live="polite">
            {saving ? '保存中…' : savedAt ? '已保存' : ''}
          </span>
          <label className="bid-improvement-content-editor-readonly">
            <span>只读</span>
            <AppSwitch checked={viewOnly} onCheckedChange={setViewOnly} aria-label="切换只读查看模式" />
          </label>
        </div>
      </header>

      {viewOnly ? (
        <div className="bid-improvement-content-editor-preview markdown-viewer">
          {draft.trim() ? (
            <MarkdownRenderer allowRawHtml={false}>{draft}</MarkdownRenderer>
          ) : (
            <p className="content-editor-empty">暂无正文内容</p>
          )}
        </div>
      ) : (
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          placeholder="输入 Markdown 正文..."
          fullscreenTitle={`${node.title || '正文'}全屏编辑`}
          fullscreenDescription={`编辑「${node.title || '未命名小节'}」（${levelLabel}）的正文内容。`}
        />
      )}
    </div>
  );
}
