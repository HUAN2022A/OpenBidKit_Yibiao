import { useEffect, useMemo, useState } from 'react';
import { MarkdownEditor, MarkdownRenderer, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, useToast } from '../../../shared/ui';
import type { ComparisonViewProps } from './PolishDialog';

/**
 * 前后对比视图（标书润色 · bid-improvement）。
 *
 * 展示「原始内容 vs 润色后内容」的左右分栏：
 * - 左侧：原始内容，只读，MarkdownRenderer 渲染。
 * - 右侧：润色后内容，默认预览，点「继续编辑」切换为 MarkdownEditor 编辑。
 * - 底部操作：采纳修改 / 拒绝 / 继续编辑；头部「返回」回到润色配置。
 *
 * 契约由 PolishDialog.tsx 导出的 ComparisonViewProps 定义（results / onBack / onClose），
 * 本组件对齐实现。results 与润色后台任务 bidImprovementPolishTask 的返回值同构：
 *   { nodeId, originalContent, polishedContent }[]
 *
 * 「采纳修改」通过 bid-improvement 的 savePolishResult IPC 写回对应目录节点并记录历史；
 * 「拒绝」同样记录历史（accepted=false），不写回正文。
 *
 * 样式约定：class 前缀 comparison-*，样式放 src/styles/feature-bid-improvement.css，
 * 在 src/styles.css 的 feature 区导入。
 */

export default function ComparisonView({ results, polishGoal, onBack, onClose }: ComparisonViewProps) {
  const { showToast } = useToast();

  const safeResults = useMemo(() => (Array.isArray(results) ? results : []), [results]);
  const total = safeResults.length;

  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [accepting, setAccepting] = useState(false);

  const currentIndex = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  const current = safeResults[currentIndex] ?? null;

  // 润色结果集合变化时回到第一项（例如重新润色后）。
  useEffect(() => {
    setIndex(0);
  }, [results]);

  // 切换展示节点时退出编辑，并把草稿重置为该节点的润色结果。
  useEffect(() => {
    setEditing(false);
    setDraft(current?.polishedContent ?? '');
  }, [current?.nodeId]);

  const finalContent = draft.trim();

  function toggleEditing() {
    setEditing((value) => !value);
  }

  function goTo(targetIndex: number) {
    setIndex(Math.min(Math.max(targetIndex, 0), Math.max(total - 1, 0)));
  }

  async function persistPolishDecision(accepted: boolean) {
    if (!current || accepting) return;

    if (accepted && !finalContent) {
      showToast('润色后内容为空，无法采纳', 'info');
      return;
    }

    const saver = window.yibiao?.bidImprovement?.savePolishResult;
    if (typeof saver !== 'function') {
      showToast('润色保存接口尚未加载，请重启应用后重试', 'error');
      return;
    }

    setAccepting(true);
    try {
      const result = await saver({
        nodeId: current.nodeId,
        polishedContent: accepted ? finalContent : current.polishedContent,
        polishGoal,
        accepted,
      });
      if (!result.success) {
        throw new Error('保存润色结果失败');
      }
      showToast(accepted ? '已采纳润色修改' : '已拒绝该润色结果', 'success');
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : (accepted ? '采纳修改失败' : '拒绝修改失败'), 'error');
    } finally {
      setAccepting(false);
    }
  }

  if (!current) {
    return (
      <div className="comparison-view comparison-view-empty">
        <p>暂无可对比的润色结果</p>
      </div>
    );
  }

  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < total - 1;

  return (
    <div className="comparison-view">
      <div className="comparison-view-header">
        <div>
          <span className="section-kicker">前后对比</span>
          <h3>润色结果对比</h3>
        </div>
        <button type="button" className="secondary-action" onClick={onBack} disabled={accepting}>
          返回
        </button>
      </div>

      {total > 1 && (
        <div className="comparison-view-nav">
          <button
            type="button"
            className="secondary-action"
            onClick={() => goTo(currentIndex - 1)}
            disabled={!canGoPrev || accepting}
            aria-label="上一节"
          >
            <ToolbarArrowLeftIcon />
          </button>
          <span>第 {currentIndex + 1} / {total} 节</span>
          <button
            type="button"
            className="secondary-action"
            onClick={() => goTo(currentIndex + 1)}
            disabled={!canGoNext || accepting}
            aria-label="下一节"
          >
            <ToolbarArrowRightIcon />
          </button>
        </div>
      )}

      <div className="comparison-view-split">
        <section className="comparison-pane comparison-pane-original">
          <div className="comparison-pane-head">
            <strong>原始内容</strong>
            <span>只读</span>
          </div>
          <div className="comparison-pane-body">
            <MarkdownRenderer allowRawHtml={false}>{current.originalContent}</MarkdownRenderer>
          </div>
        </section>

        <section className="comparison-pane comparison-pane-polished">
          <div className="comparison-pane-head">
            <strong>润色后内容</strong>
            <span>{editing ? '编辑中' : '可编辑'}</span>
          </div>
          <div className="comparison-pane-body">
            {editing ? (
              <MarkdownEditor
                value={draft}
                onChange={setDraft}
                placeholder="请输入润色后的正文内容..."
                fullscreenTitle="润色后内容全屏编辑"
                fullscreenDescription="编辑当前小节的润色后内容。"
              />
            ) : (
              <MarkdownRenderer allowRawHtml={false}>{draft}</MarkdownRenderer>
            )}
          </div>
        </section>
      </div>

      <div className="comparison-view-actions">
        <button type="button" className="secondary-action" onClick={() => void persistPolishDecision(false)} disabled={accepting}>
          拒绝
        </button>
        <button type="button" className="secondary-action" onClick={toggleEditing} disabled={accepting}>
          {editing ? '完成编辑' : '继续编辑'}
        </button>
        <button type="button" className="primary-action" onClick={() => void persistPolishDecision(true)} disabled={accepting}>
          {accepting ? '采纳中...' : '采纳修改'}
        </button>
      </div>
    </div>
  );
}
