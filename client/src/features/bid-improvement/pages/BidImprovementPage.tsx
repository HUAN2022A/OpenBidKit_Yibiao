import { useEffect, useMemo, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, FloatingToolbar, ToolbarDocumentIcon, ToolbarOutlineIcon, ToolbarSparkleIcon, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type { SectionId } from '../../../shared/types/navigation';
import type { BidImprovementDocument, BidImprovementOutlineNode, BidImprovementRole, BidImprovementWorkspaceState } from '../types';
import OutlineTree from '../components/OutlineTree';
import ContentEditor from '../components/ContentEditor';
import PolishDialog from '../components/PolishDialog';

/**
 * 标书改进主页面（bid-improvement）。
 *
 * 面向「完成态标书提质」：导入已写好的标书，按目录树浏览/编辑正文小节，
 * 对选中小节做表达层面润色，并把投标文件桥接到废标项检查、导出 Word。
 *
 * 布局：左侧目录树（约 30%）+ 右侧内容编辑器（约 70%）+ 底部 FloatingToolbar。
 * 状态由本页面通过 window.yibiao.bidImprovement 桥接层加载与持久化，润色后台任务
 * 由 PolishDialog 组件自行订阅（tasks.startBidImprovementPolish / onTaskEvent）。
 */

interface BidImprovementPageProps {
  onSectionChange?: (section: SectionId) => void;
}

const roleLabels: Record<BidImprovementRole, string> = {
  tender: '招标文件',
  bid: '投标文件',
};

function findNode(nodes: BidImprovementOutlineNode[], id: string): BidImprovementOutlineNode | null {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const found = findNode(node.children || [], id);
    if (found) return found;
  }
  return null;
}

/** 收集所有叶子且带正文的小节，作为可润色对象。 */
function collectPolishableNodes(nodes: BidImprovementOutlineNode[]): BidImprovementOutlineNode[] {
  const result: BidImprovementOutlineNode[] = [];
  const visit = (items: BidImprovementOutlineNode[]) => {
    for (const node of items || []) {
      if (node.children?.length) {
        visit(node.children);
      } else if (String(node.content || '').trim()) {
        result.push(node);
      }
    }
  };
  visit(nodes);
  return result;
}

function updateNodeContent(nodes: BidImprovementOutlineNode[], nodeId: string, content: string): BidImprovementOutlineNode[] {
  return nodes.map((node) => {
    if (node.id === nodeId) return { ...node, content };
    if (node.children?.length) return { ...node, children: updateNodeContent(node.children, nodeId, content) };
    return node;
  });
}

function buildPreviewContent(nodes: BidImprovementOutlineNode[]): string {
  return nodes
    .map((node) => `### ${node.title || '未命名小节'}\n\n${String(node.content || '').trim()}`)
    .join('\n\n');
}

function BidImprovementPage({ onSectionChange }: BidImprovementPageProps) {
  const { showToast } = useToast();

  // ---- 工作区状态 ----
  const [documents, setDocuments] = useState<BidImprovementDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // ---- 交互状态 ----
  const [busy, setBusy] = useState<'upload' | 'export' | 'check' | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [exportedPath, setExportedPath] = useState('');
  const [polishOpen, setPolishOpen] = useState(false);
  const [polishTargetIds, setPolishTargetIds] = useState<string[]>([]);
  const [polishPreviewContent, setPolishPreviewContent] = useState('');

  // ---- 派生状态 ----
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const activeNodeId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
  const activeNode = activeDocument && activeNodeId ? findNode(activeDocument.outline, activeNodeId) : null;
  const polishableNodes = useMemo(
    () => (activeDocument ? collectPolishableNodes(activeDocument.outline) : []),
    [activeDocument],
  );
  const polishableSelectedNodes = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return polishableNodes.filter((node) => selectedSet.has(node.id));
  }, [polishableNodes, selectedIds]);
  const canPolish = polishableSelectedNodes.length > 0;

  // ---- 状态应用 ----
  function applyWorkspaceState(state: BidImprovementWorkspaceState | null | undefined) {
    const nextDocuments = Array.isArray(state?.documents) ? state.documents : [];
    setDocuments(nextDocuments);
    const nextActiveDocumentId = state?.activeDocumentId && nextDocuments.some((document) => document.id === state.activeDocumentId)
      ? state.activeDocumentId
      : nextDocuments[0]?.id ?? null;
    setActiveDocumentId(nextActiveDocumentId);
    const nextActiveDocument = nextDocuments.find((document) => document.id === nextActiveDocumentId);
    const restoreNodeId = state?.activeNodeId && nextActiveDocument && findNode(nextActiveDocument.outline, state.activeNodeId)
      ? state.activeNodeId
      : null;
    setSelectedIds(restoreNodeId ? [restoreNodeId] : []);
  }

  // ---- 挂载：埋点 + 加载状态 ----
  useEffect(() => {
    trackPageView('bid-improvement');
  }, []);

  useEffect(() => {
    let canceled = false;
    const api = window.yibiao.bidImprovement;
    if (!api?.getWorkspaceState) {
      setHydrated(true);
      return;
    }
    void api.getWorkspaceState()
      .then((state) => {
        if (canceled || !state) return;
        applyWorkspaceState(state);
      })
      .catch((error) => {
        if (canceled) return;
        showToast(error instanceof Error ? error.message : '读取标书改进缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) setHydrated(true);
      });
    return () => {
      canceled = true;
    };
  }, [showToast]);

  // ---- 持久化轻量 UI 状态 ----
  useEffect(() => {
    if (!hydrated) return;
    void window.yibiao.bidImprovement.updateWorkspaceState({ activeDocumentId, activeNodeId })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存页面状态失败', 'error');
      });
  }, [hydrated, activeDocumentId, activeNodeId, showToast]);

  // ---- 文档切换 ----
  function handleDocumentChange(nextDocumentId: string) {
    setActiveDocumentId(nextDocumentId);
    setSelectedIds([]);
  }

  // ---- 上传 / 移除 ----
  async function handleImport(role: BidImprovementRole) {
    const api = window.yibiao.bidImprovement;
    const fileSelector = window.yibiao.file?.selectDuplicateCheckFiles;
    if (typeof api?.importDocument !== 'function') {
      showToast('文件导入接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (typeof fileSelector !== 'function') {
      showToast('文件选择接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    setBusy('upload');
    try {
      const selection = await fileSelector({ multiple: false });
      if (!selection?.success || !selection.files?.length) {
        const message = selection?.message || `未选择${roleLabels[role]}`;
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      const filePath = selection.files[0]?.file_path;
      if (!filePath) {
        showToast('未获取到文件路径', 'error');
        return;
      }
      const result = await api.importDocument(filePath, role);
      if (!result?.success) {
        showToast(result?.message || `导入${roleLabels[role]}失败`, 'error');
        return;
      }
      applyWorkspaceState(await api.getWorkspaceState());
      if (result.documentId) {
        setActiveDocumentId(result.documentId);
        setSelectedIds([]);
      }
      showToast(result.message || `${roleLabels[role]}已导入`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : `导入${roleLabels[role]}失败`, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveDocument(documentId: string) {
    const api = window.yibiao.bidImprovement;
    if (typeof api?.deleteDocument !== 'function') {
      showToast('移除接口尚未加载', 'error');
      return;
    }
    setBusy('upload');
    try {
      await api.deleteDocument(documentId);
      applyWorkspaceState(await api.getWorkspaceState());
    } catch (error) {
      showToast(error instanceof Error ? error.message : '移除文档失败', 'error');
    } finally {
      setBusy(null);
    }
  }

  // ---- 正文保存后同步本地状态 ----
  function handleContentSaved(payload: { documentId: string; nodeId: string; content: string }) {
    setDocuments((prev) => prev.map((document) => (
      document.id !== payload.documentId
        ? document
        : { ...document, outline: updateNodeContent(document.outline, payload.nodeId, payload.content) }
    )));
  }

  // ---- 润色 ----
  function openPolishDialog() {
    if (!polishableSelectedNodes.length) return;
    setPolishTargetIds(polishableSelectedNodes.map((node) => node.id));
    setPolishPreviewContent(buildPreviewContent(polishableSelectedNodes));
    setPolishOpen(true);
  }

  // ---- 标书检查（桥接废标项检查并跳转） ----
  async function handleBridgeToRejectionCheck() {
    const api = window.yibiao.bidImprovement;
    if (typeof api?.bridgeToRejectionCheck !== 'function') {
      showToast('标书检查接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (!activeDocument) return;
    setBusy('check');
    try {
      const result = await api.bridgeToRejectionCheck(activeDocument.id);
      if (!result?.success) {
        showToast(result?.message || '导入废标项检查失败', 'error');
        return;
      }
      showToast('已导入废标项检查', 'success');
      onSectionChange?.('rejection-check');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导入废标项检查失败', 'error');
    } finally {
      setBusy(null);
    }
  }

  // ---- 导出 Word ----
  async function handleExportDocument() {
    const api = window.yibiao.bidImprovement;
    if (typeof api?.exportDocument !== 'function') {
      showToast('导出接口尚未加载', 'error');
      return;
    }
    if (!activeDocument) return;
    setBusy('export');
    try {
      const result = await api.exportDocument(activeDocument.id);
      if (!result?.success) {
        const message = result?.message || '导出 Word 失败';
        showToast(message, message === '已取消导出' ? 'info' : 'error');
        return;
      }
      setExportedPath(result.path || '');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出 Word 失败', 'error');
    } finally {
      setBusy(null);
    }
  }

  // ---- 工具栏 ----
  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'bid-improvement-upload',
      actions: [{
        id: 'upload',
        label: busy === 'upload' ? '上传中...' : '上传标书',
        icon: <ToolbarDocumentIcon />,
        variant: 'primary',
        disabled: busy !== null,
        tooltip: '导入投标文件或招标文件',
        onClick: () => setUploadDialogOpen(true),
      }],
    },
    {
      id: 'bid-improvement-polish',
      actions: [{
        id: 'polish',
        label: '润色内容',
        icon: <ToolbarSparkleIcon />,
        variant: 'ai',
        disabled: !canPolish,
        tooltip: canPolish ? '对所选正文小节做表达层面润色' : '请先选择包含正文的小节',
        onClick: openPolishDialog,
      }],
    },
    {
      id: 'bid-improvement-check',
      actions: [{
        id: 'check',
        label: busy === 'check' ? '导入中...' : '标书检查',
        icon: <ToolbarOutlineIcon />,
        disabled: busy !== null || !activeDocument || activeDocument.role !== 'bid',
        tooltip: !activeDocument || activeDocument.role !== 'bid' ? '需要先导入投标文件' : '导入废标项检查并跳转',
        onClick: () => { void handleBridgeToRejectionCheck(); },
      }],
    },
    {
      id: 'bid-improvement-export',
      actions: [{
        id: 'export',
        label: busy === 'export' ? '导出中...' : '导出 Word',
        icon: <ToolbarDocumentIcon />,
        variant: 'success',
        disabled: busy !== null || !activeDocument,
        tooltip: !activeDocument ? '请先导入标书文档' : '将当前标书目录导出为 Word 文档',
        onClick: () => { void handleExportDocument(); },
      }],
    },
  ];

  return (
    <div className="bid-improvement-page" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="bid-improvement-workspace" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 7fr)', overflow: 'hidden' }}>
        {/* 左侧：目录树（约 30%） */}
        <aside
          className="bid-improvement-tree-panel"
          style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--yb-border-soft)', overflow: 'hidden' }}
        >
          <div className="bid-improvement-tree-head" style={{ padding: '14px 16px', borderBottom: '1px solid var(--yb-border-soft)', display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gap: 2 }}>
              <span className="section-kicker">标书目录</span>
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeDocument ? activeDocument.fileName : '未选择标书'}
              </strong>
              {activeDocument && <small style={{ color: 'var(--yb-text-soft)' }}>{roleLabels[activeDocument.role]}</small>}
            </div>
            {documents.length > 1 && (
              <select value={activeDocumentId ?? ''} onChange={(event) => handleDocumentChange(event.target.value)} aria-label="切换标书文档">
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {roleLabels[document.role]} · {document.fileName}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="bid-improvement-tree-body" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <OutlineTree
              items={activeDocument?.outline ?? []}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              emptyText={activeDocument ? '该文档没有可识别的目录结构' : '上传标书后展示目录结构'}
            />
          </div>
        </aside>

        {/* 右侧：内容编辑器（约 70%） */}
        <article className="bid-improvement-editor-panel" style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ContentEditor
            node={activeNode}
            documentId={activeDocument?.id ?? ''}
            onContentSaved={handleContentSaved}
          />
        </article>
      </div>

      {/* 上传对话框 */}
      <AppDialog
        open={uploadDialogOpen}
        onOpenChange={(open) => !open && setUploadDialogOpen(false)}
        kicker="上传标书"
        title="导入标书文档"
        description="导入投标文件或招标文件，自动提取目录树与正文。"
      >
        <div className="bid-improvement-upload-form" style={{ display: 'grid', gap: 16 }}>
          <div className="bid-improvement-upload-actions" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="primary-action" onClick={() => { void handleImport('bid'); }} disabled={busy !== null}>
              {busy === 'upload' ? '解析中...' : '上传投标文件'}
            </button>
            <button type="button" className="secondary-action" onClick={() => { void handleImport('tender'); }} disabled={busy !== null}>
              {busy === 'upload' ? '解析中...' : '上传招标文件'}
            </button>
          </div>
          {documents.length > 0 && (
            <div className="bid-improvement-document-list" style={{ display: 'grid', gap: 8 }}>
              {documents.map((document) => (
                <div key={document.id} className="bid-improvement-document-entry" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--yb-border-soft)', borderRadius: 8 }}>
                  <span className="bid-improvement-document-role" style={{ fontSize: 12, color: 'var(--yb-text-soft)', flexShrink: 0 }}>
                    {roleLabels[document.role]}
                  </span>
                  <span className="bid-improvement-document-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                    {document.fileName}
                  </span>
                  <button type="button" className="text-button" onClick={() => { void handleRemoveDocument(document.id); }} disabled={busy !== null}>
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </AppDialog>

      {/* 润色对话框 */}
      <PolishDialog
        open={polishOpen}
        onOpenChange={setPolishOpen}
        nodeIds={polishTargetIds}
        selectedContent={polishPreviewContent}
        onComplete={() => { showToast('润色完成', 'success'); }}
      />

      {/* 导出结果对话框 */}
      <AppDialog
        open={Boolean(exportedPath)}
        onOpenChange={(open) => !open && setExportedPath('')}
        kicker="导出完成"
        title="Word 文档已导出"
        description={exportedPath ? `文件已保存到：${exportedPath}` : undefined}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setExportedPath('')}>稍后打开</button>
            <button type="button" className="primary-action" onClick={() => { void window.yibiao.export.openFile(exportedPath); }}>打开文件</button>
          </>
        )}
      />

      <FloatingToolbar groups={toolbarGroups} label="标书改进工具条" />
    </div>
  );
}

export default BidImprovementPage;
