import { useEffect, useRef, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, FloatingToolbar, MarkdownRenderer, ProgressBar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  EvaluationActiveTab,
  EvaluationBackgroundTaskState,
  EvaluationDocumentContent,
  EvaluationResultState,
  EvaluationRunOptions,
  EvaluationRunStatus,
  EvaluationScoreItem,
  EvaluationScoringItemsState,
  EvaluationScoringItemsStatus,
  EvaluationStep,
  EvaluationWorkspacePatch,
  EvaluationWorkspaceState,
} from '../types';

// Agent C 装配层尚未在 ipc.ts 落类型，此处按契约第四节/第六节做本地窄类型桥接。
// 结构上与被装配后的 window.yibiao.evaluation / window.yibiao.tasks 一致，最终类型由 ipc.ts 统一收口。
interface EvaluationExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  message?: string;
}

interface EvaluationApi {
  loadState: () => Promise<EvaluationWorkspaceState>;
  importFromTechnicalPlan: () => Promise<{ success: boolean; message?: string }>;
  saveUiState: (payload: { activeTab?: EvaluationActiveTab }) => Promise<void>;
  updateState: (partial: EvaluationWorkspacePatch) => Promise<void>;
  exportExcel: (request?: unknown) => Promise<EvaluationExportResult>;
  clear: () => Promise<{ success: boolean; message?: string }>;
}

interface EvaluationTasksApi {
  startEvaluation: (payload: unknown) => Promise<unknown>;
  getActiveTasks: () => Promise<Array<{ type?: string }>>;
  onTaskEvent: (callback: (event: unknown) => void) => () => void;
}

function getEvaluationApi(): EvaluationApi | undefined {
  const bridge = window.yibiao as unknown as { evaluation?: EvaluationApi };
  return bridge?.evaluation;
}

function getEvaluationTasksApi(): EvaluationTasksApi | undefined {
  const bridge = window.yibiao as unknown as { tasks?: EvaluationTasksApi };
  return bridge?.tasks;
}

const steps: EvaluationStep[] = ['documents', 'items', 'results'];

const stepLabels: Record<EvaluationStep, string> = {
  documents: '导入方案',
  items: '开始评标',
  results: '评标结果',
};

const previewTabs: Array<{ id: 'scoring' | 'document'; label: string }> = [
  { id: 'scoring', label: '评分标准' },
  { id: 'document', label: '标书正文' },
];

const scoringStatusLabels: Record<EvaluationScoringItemsStatus, string> = {
  idle: '待导入',
  success: '已导入',
  error: '导入失败',
};

const runStatusLabels: Record<EvaluationRunStatus, string> = {
  idle: '待评标',
  running: '评标中',
  success: '已完成',
  error: '评标失败',
};

function createEmptyScoringItemsState(): EvaluationScoringItemsState {
  return { status: 'idle', content: '', source: 'technical-plan' };
}

function createEmptyResultState(): EvaluationResultState {
  return { status: 'idle', totalScore: 0, totalMaxScore: 0, scoreRate: 0, overallComment: '', items: [] };
}

function stripTripleQuoteWrapper(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return content;
}

function toFiniteNumber(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function normalizeDocument(state: unknown): EvaluationDocumentContent | null {
  if (!state || typeof state !== 'object') return null;
  const doc = state as Record<string, unknown>;
  const id = typeof doc.id === 'string' ? doc.id : '';
  const fileName = typeof doc.fileName === 'string' ? doc.fileName : '';
  const content = typeof doc.content === 'string' ? doc.content : '';
  if (!id && !fileName && !content.trim()) return null;
  return {
    id,
    role: 'technical-plan',
    fileName: fileName.trim() || '技术方案正文',
    content,
    source: 'technical-plan',
    importedAt: typeof doc.importedAt === 'string' ? doc.importedAt : '',
  };
}

function normalizeScoringItems(state: unknown): EvaluationScoringItemsState {
  if (!state || typeof state !== 'object') return createEmptyScoringItemsState();
  const s = state as Record<string, unknown>;
  const status = ['idle', 'success', 'error'].includes(String(s.status)) ? s.status as EvaluationScoringItemsStatus : 'idle';
  return {
    status,
    content: typeof s.content === 'string' ? stripTripleQuoteWrapper(s.content) : '',
    source: 'technical-plan',
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  };
}

function normalizeRunOptions(state: unknown): EvaluationRunOptions {
  const s = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
  const judgeCount = Number.isFinite(Number(s.judgeCount)) && Number(s.judgeCount) >= 1 ? Math.floor(Number(s.judgeCount)) : 1;
  return { judgeCount };
}

function normalizeScoreItem(item: unknown, index: number): EvaluationScoreItem | null {
  if (!item || typeof item !== 'object') return null;
  const s = item as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  if (!name) return null;
  return {
    id: typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `evaluation-score-${index + 1}`,
    name,
    maxScore: toFiniteNumber(s.maxScore),
    score: toFiniteNumber(s.score),
    criteria: typeof s.criteria === 'string' ? s.criteria.trim() : '',
    evidence: typeof s.evidence === 'string' ? s.evidence.trim() : '',
    deductionReason: typeof s.deductionReason === 'string' ? s.deductionReason.trim() : '',
    suggestion: typeof s.suggestion === 'string' ? s.suggestion.trim() : '',
  };
}

function normalizeResultState(state?: Partial<EvaluationResultState> | null): EvaluationResultState {
  if (!state || typeof state !== 'object') return createEmptyResultState();
  const status = ['idle', 'running', 'success', 'error'].includes(String(state.status)) ? state.status as EvaluationRunStatus : 'idle';
  const items = Array.isArray(state.items)
    ? state.items.map((item, index) => normalizeScoreItem(item, index)).filter((item): item is EvaluationScoreItem => Boolean(item))
    : [];
  const totalScore = toFiniteNumber(state.totalScore);
  const totalMaxScore = toFiniteNumber(state.totalMaxScore);
  const scoreRate = Number.isFinite(Number(state.scoreRate))
    ? Number(state.scoreRate)
    : (totalMaxScore > 0 ? totalScore / totalMaxScore : 0);
  const activeItemId = items.some((item) => item.id === state.activeItemId) ? state.activeItemId : undefined;
  return {
    status,
    inputSignature: typeof state.inputSignature === 'string' ? state.inputSignature : undefined,
    totalScore,
    totalMaxScore,
    scoreRate,
    overallComment: typeof state.overallComment === 'string' ? state.overallComment : '',
    items,
    activeItemId,
    progressMessage: typeof state.progressMessage === 'string' ? state.progressMessage : undefined,
    error: typeof state.error === 'string' ? state.error : undefined,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : undefined,
  };
}

function normalizeBackgroundTaskState(state?: Partial<EvaluationBackgroundTaskState> | null): EvaluationBackgroundTaskState | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const type = state.type === 'evaluation-run' ? state.type : undefined;
  const status = state.status === 'running' || state.status === 'success' || state.status === 'error' ? state.status : undefined;
  if (!type || !status || typeof state.task_id !== 'string') return undefined;
  return {
    task_id: state.task_id,
    type,
    status,
    progress: Number.isFinite(Number(state.progress)) ? Number(state.progress) : 0,
    logs: Array.isArray(state.logs) ? state.logs.map((item) => String(item)) : [],
    started_at: typeof state.started_at === 'string' ? state.started_at : new Date().toISOString(),
    updated_at: typeof state.updated_at === 'string' ? state.updated_at : new Date().toISOString(),
    error: typeof state.error === 'string' ? state.error : undefined,
  };
}

function formatContentLength(content: string) {
  const length = content.trim().length;
  if (length >= 10000) return `${(length / 10000).toFixed(1)} 万字`;
  return `${length} 字`;
}

function formatImportedAt(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatScore(value: number) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function getEvaluationProgress(status: EvaluationRunStatus, task?: EvaluationBackgroundTaskState) {
  if (status === 'success' || status === 'error') return 100;
  if (status !== 'running') return 0;
  if (task && Number.isFinite(task.progress) && task.progress >= 0) return task.progress;
  return 10;
}

function FindingDetailBlock({ label, content, allowRawHtml = false }: { label: string; content: string; allowRawHtml?: boolean }) {
  return (
    <div className="rejection-finding-detail-block">
      <strong>{label}</strong>
      <div className="markdown-viewer rejection-finding-markdown">
        <MarkdownRenderer allowRawHtml={allowRawHtml}>
          {content || '未提供'}
        </MarkdownRenderer>
      </div>
    </div>
  );
}

function EvaluationScoreItemCard({ item, index, expanded, onToggle }: { item: EvaluationScoreItem; index: number; expanded: boolean; onToggle: () => void }) {
  return (
    <article className={`rejection-finding-item${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong>{`${index + 1}. ${item.name}`}</strong>
              <em style={{ padding: '3px 9px', fontSize: 12, fontWeight: 800, fontStyle: 'normal', color: 'var(--yb-primary)', background: 'rgba(33, 116, 253, 0.1)', borderRadius: 'var(--yb-radius-pill)' }}>
                {`得分 ${formatScore(item.score)} / ${formatScore(item.maxScore)}`}
              </em>
            </span>
            <small>{item.criteria || '未提供评分标准'}</small>
          </span>
        </button>
      </div>

      {expanded && (
        <div className="rejection-finding-detail">
          <FindingDetailBlock label="评分标准" content={item.criteria} allowRawHtml />
          <FindingDetailBlock label="标书证据" content={item.evidence} allowRawHtml />
          <FindingDetailBlock label="扣分/得分理由" content={item.deductionReason} />
          <FindingDetailBlock label="改进建议" content={item.suggestion} />
        </div>
      )}
    </article>
  );
}

function EvaluationPage() {
  const [step, setStep] = useState<EvaluationStep>('documents');
  const [previewTab, setPreviewTab] = useState<'scoring' | 'document'>('scoring');
  const [technicalPlanDocument, setTechnicalPlanDocument] = useState<EvaluationDocumentContent | null>(null);
  const [scoringItems, setScoringItems] = useState<EvaluationScoringItemsState>(() => createEmptyScoringItemsState());
  const [runOptions, setRunOptions] = useState<EvaluationRunOptions>({ judgeCount: 1 });
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResultState>(() => createEmptyResultState());
  const [evaluationTask, setEvaluationTask] = useState<EvaluationBackgroundTaskState | undefined>();
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedExcelPath, setExportedExcelPath] = useState('');
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const hydratedRef = useRef(false);
  const activeTaskTypesRef = useRef<Set<string> | null>(null);
  const { showToast } = useToast();

  const hasDocument = Boolean(technicalPlanDocument && technicalPlanDocument.content.trim());
  const hasScoring = Boolean(scoringItems.content.trim());
  const hasImported = hasDocument || hasScoring;
  const evaluationRunning = evaluationResult.status === 'running' || evaluationTask?.status === 'running';
  const hasResult = evaluationResult.status !== 'idle' || evaluationResult.items.length > 0;
  const hasExportableResult = evaluationResult.status === 'success';
  const activeIndex = steps.indexOf(step);
  const progress = getEvaluationProgress(evaluationResult.status, evaluationTask);
  const scoreRatePercent = Number.isFinite(evaluationResult.scoreRate) ? (evaluationResult.scoreRate * 100).toFixed(1) : '0.0';

  function applyWorkspaceState(state: EvaluationWorkspaceState, options: { syncStep?: boolean } = {}) {
    const syncStep = options.syncStep !== false;
    setTechnicalPlanDocument(normalizeDocument(state.technicalPlanDocument));
    setScoringItems(normalizeScoringItems(state.scoringItems));
    setRunOptions(normalizeRunOptions(state.runOptions));
    setEvaluationResult(normalizeResultState(state.evaluationResult));
    setEvaluationTask(normalizeBackgroundTaskState(state.evaluationTask));
    if (syncStep) {
      setStep(state.activeTab === 'results' ? 'results' : 'documents');
    }
  }

  function applyWorkspacePatch(patch: EvaluationWorkspacePatch) {
    const has = (field: keyof EvaluationWorkspaceState) => Object.prototype.hasOwnProperty.call(patch, field);
    if (has('technicalPlanDocument')) setTechnicalPlanDocument(normalizeDocument(patch.technicalPlanDocument));
    if (has('scoringItems')) setScoringItems(normalizeScoringItems(patch.scoringItems));
    if (has('runOptions')) setRunOptions(normalizeRunOptions(patch.runOptions));
    if (has('evaluationResult')) {
      setEvaluationResult((prev) => patch.evaluationResult === undefined
        ? createEmptyResultState()
        : normalizeResultState({ ...prev, ...patch.evaluationResult }));
    }
    if (has('evaluationTask')) setEvaluationTask(normalizeBackgroundTaskState(patch.evaluationTask));
    if (has('activeTab')) setStep(patch.activeTab === 'results' ? 'results' : 'documents');
  }

  function persistEvaluationState(partial: EvaluationWorkspacePatch, fallbackMessage: string) {
    const api = getEvaluationApi();
    if (!api) return;
    void api.updateState(partial).catch((error) => {
      showToast(error instanceof Error ? error.message : fallbackMessage, 'error');
    });
  }

  useEffect(() => {
    if (!analyticsReady) return;
    const page = step === 'documents' ? 'ai-evaluation/documents' : step === 'items' ? 'ai-evaluation/items' : 'ai-evaluation/results';
    trackPageView(page);
  }, [analyticsReady, step]);

  useEffect(() => {
    let canceled = false;
    const api = getEvaluationApi();
    if (!api) {
      hydratedRef.current = true;
      setAnalyticsReady(true);
      return;
    }

    void api.loadState()
      .then((state) => {
        if (canceled || !state) return;
        applyWorkspaceState(state);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取AI评标缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) {
          hydratedRef.current = true;
          setAnalyticsReady(true);
          if (activeTaskTypesRef.current && !activeTaskTypesRef.current.has('evaluation-run')) {
            markStaleEvaluationTask();
          }
        }
      });

    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const api = getEvaluationApi();
    if (!api) return;
    void api.saveUiState({ activeTab: step === 'results' ? 'results' : 'documents' })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存AI评标页面状态失败', 'error');
      });
  }, [step, showToast]);

  useEffect(() => {
    const tasks = getEvaluationTasksApi();
    if (!tasks) return;

    const unsubscribe = tasks.onTaskEvent((rawEvent) => {
      const event = rawEvent as { evaluation?: EvaluationWorkspaceState; evaluationPatch?: EvaluationWorkspacePatch };
      if (event.evaluation) {
        applyWorkspaceState(event.evaluation, { syncStep: false });
      }
      if (event.evaluationPatch) {
        applyWorkspacePatch(event.evaluationPatch);
      }
    });

    void tasks.getActiveTasks()
      .then((list) => {
        const activeTypes = new Set((Array.isArray(list) ? list : [])
          .map((task) => (task && typeof task.type === 'string' ? task.type : '')));
        activeTaskTypesRef.current = activeTypes;
        if (hydratedRef.current && !activeTypes.has('evaluation-run')) {
          markStaleEvaluationTask();
        }
      })
      .catch((error) => {
        console.warn('获取AI评标后台任务状态失败', error);
      });

    return unsubscribe;
  }, []);

  function markStaleEvaluationTask() {
    const staleMessage = '上次评标未完成，请重新评标';
    setEvaluationResult((prev) => prev.status === 'running'
      ? { ...prev, status: 'error', error: staleMessage, progressMessage: staleMessage, updatedAt: new Date().toISOString() }
      : prev);
    setEvaluationTask((prev) => prev?.status === 'running'
      ? { ...prev, status: 'error', progress: 100, error: staleMessage, logs: [staleMessage], updated_at: new Date().toISOString() }
      : prev);
  }

  async function importFromTechnicalPlan() {
    const api = getEvaluationApi();
    if (!api) {
      showToast('AI评标接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (importing) return;
    setImporting(true);
    try {
      const result = await api.importFromTechnicalPlan();
      if (!result?.success) {
        showToast(result?.message || '技术方案中暂无评分标准与正文，请先完成招标解析与正文生成', 'info');
        return;
      }
      applyWorkspaceState(await api.loadState());
      showToast(result.message || '已从技术方案导入评分标准与正文', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导入技术方案失败', 'error');
    } finally {
      setImporting(false);
    }
  }

  async function startEvaluation() {
    if (evaluationRunning) return;
    if (!hasImported) {
      showToast('请先从技术方案导入评分标准与正文', 'info');
      setStep('documents');
      return;
    }

    const starter = getEvaluationTasksApi()?.startEvaluation;
    if (typeof starter !== 'function') {
      showToast('后台任务接口尚未加载，请重启应用后重试', 'error');
      return;
    }

    const startedAt = new Date().toISOString();
    const nextResult: EvaluationResultState = {
      status: 'running',
      totalScore: 0,
      totalMaxScore: 0,
      scoreRate: 0,
      overallComment: '',
      items: [],
      progressMessage: '正在拆解评分项。',
      updatedAt: startedAt,
    };
    const nextTask: EvaluationBackgroundTaskState = {
      task_id: `local-${Date.now()}`,
      type: 'evaluation-run',
      status: 'running',
      progress: 5,
      logs: ['正在启动评标任务。'],
      started_at: startedAt,
      updated_at: startedAt,
    };
    setEvaluationResult(nextResult);
    setEvaluationTask(nextTask);

    try {
      await starter({ runOptions: { judgeCount: runOptions.judgeCount } });
      showToast('评标任务已在后台启动', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动评标任务失败';
      setEvaluationResult((prev) => prev.status === 'running'
        ? { ...prev, status: 'error', error: message, progressMessage: message, updatedAt: new Date().toISOString() }
        : prev);
      setEvaluationTask((prev) => prev ? { ...prev, status: 'error', progress: 100, error: message, logs: [message], updated_at: new Date().toISOString() } : prev);
      showToast(message, 'error');
    }
  }

  function resetWorkspace() {
    setStep('documents');
    setPreviewTab('scoring');
    setTechnicalPlanDocument(null);
    setScoringItems(createEmptyScoringItemsState());
    setRunOptions({ judgeCount: 1 });
    setEvaluationResult(createEmptyResultState());
    setEvaluationTask(undefined);
    const api = getEvaluationApi();
    if (!api) return;
    void api.clear()
      .then(() => {
        showToast('已清空评标数据', 'success');
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空评标数据失败', 'error');
      });
  }

  async function exportExcel() {
    const api = getEvaluationApi();
    if (typeof api?.exportExcel !== 'function') {
      showToast('评标结果导出接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    setExporting(true);
    try {
      const result = await api.exportExcel({});
      if (result.canceled) return;
      if (!result.success || !result.path) {
        showToast(result.message || '评标结果导出失败', 'error');
        return;
      }
      setExportedExcelPath(result.path);
      showToast(result.message || '评标结果已导出', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '评标结果导出失败', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function openExportedExcelFile() {
    if (!exportedExcelPath) return;
    try {
      await window.yibiao.export.openFile(exportedExcelPath);
      setExportedExcelPath('');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 Excel 文件失败', 'error');
    }
  }

  function toggleScoreItem(itemId: string) {
    const next = {
      ...evaluationResult,
      activeItemId: evaluationResult.activeItemId === itemId ? undefined : itemId,
      updatedAt: new Date().toISOString(),
    };
    setEvaluationResult(next);
    persistEvaluationState(
      { evaluationResult: { activeItemId: next.activeItemId, updatedAt: next.updatedAt } },
      '保存评标结果状态失败',
    );
  }

  function switchStep(nextStep: EvaluationStep) {
    if (nextStep === 'items' && !hasImported) {
      showToast('请先从技术方案导入评分标准与正文', 'info');
      setStep('documents');
      return;
    }
    if (nextStep === 'results' && !hasResult) {
      showToast('请先完成一次评标', 'info');
      return;
    }
    setStep(nextStep);
  }

  function goToOffset(offset: number) {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      switchStep(nextStep);
    }
  }

  function renderDocumentsStep() {
    const previewContent = previewTab === 'scoring' ? scoringItems.content : (technicalPlanDocument?.content ?? '');
    const previewEmpty = !previewContent.trim();

    return (
      <>
        <section className="rejection-result-command-bar">
          <div>
            <span className="section-kicker">STEP 01</span>
            <strong>导入方案</strong>
            <p>从技术方案导入评分标准与标书正文，作为 AI 评标的依据。</p>
          </div>
          <div className={`rejection-result-status is-${hasImported ? 'success' : scoringItems.status === 'error' ? 'error' : 'idle'}`}>
            <span>{hasImported ? '已导入' : scoringItems.status === 'error' ? scoringStatusLabels.error : scoringStatusLabels.idle}</span>
            <small>{hasDocument ? `标书正文 ${formatContentLength(technicalPlanDocument?.content ?? '')}` : hasScoring ? '已读取评分标准' : '等待从技术方案导入'}</small>
          </div>
          <button type="button" className="primary-action" onClick={() => void importFromTechnicalPlan()} disabled={importing || evaluationRunning}>
            {importing ? '导入中...' : hasImported ? '重新导入' : '从技术方案导入'}
          </button>
        </section>

        <div className="document-switch-tabs" role="tablist" aria-label="导入内容预览切换">
          {previewTabs.map((tab) => {
            const isActive = tab.id === previewTab;
            return (
              <button
                type="button"
                className={`document-switch-tab${isActive ? ' is-active' : ''}`}
                role="tab"
                aria-selected={isActive}
                key={tab.id}
                onClick={() => setPreviewTab(tab.id)}
              >
                <strong>{tab.label}</strong>
              </button>
            );
          })}
        </div>

        <section className="rejection-reader-card analysis-markdown-card">
          <div className="analysis-result-head rejection-reader-head">
            <strong>{previewTab === 'scoring' ? '评分标准' : '标书正文'}</strong>
            <span>{previewTab === 'scoring'
              ? (hasScoring ? `来自技术方案 · ${formatContentLength(scoringItems.content)}` : '等待导入')
              : (hasDocument ? `${technicalPlanDocument?.fileName ?? ''} · ${formatContentLength(technicalPlanDocument?.content ?? '')} · ${formatImportedAt(technicalPlanDocument?.importedAt)}` : '等待导入')}</span>
          </div>

          {previewEmpty ? (
            <div className="markdown-empty-state rejection-empty-reader">
              <strong>{previewTab === 'scoring' ? '尚未导入评分标准' : '尚未导入标书正文'}</strong>
              <p>点击上方「从技术方案导入」，读取技术方案中的评分标准与已生成的正文。</p>
            </div>
          ) : (
            <div className="markdown-viewer" style={{ padding: '18px 22px', minHeight: 0, overflow: 'auto' }}>
              <MarkdownRenderer>{previewContent}</MarkdownRenderer>
            </div>
          )}
        </section>
      </>
    );
  }

  function renderItemsStep() {
    return (
      <>
        <section className="rejection-result-command-bar">
          <div>
            <span className="section-kicker">STEP 02</span>
            <strong>开始评标</strong>
            <p>AI 将拆解评分项、逐项打分并汇总总分与总体评语。</p>
          </div>
          <div className={`rejection-result-status is-${evaluationResult.status}`}>
            <span>{runStatusLabels[evaluationResult.status]}</span>
            <small>{evaluationResult.progressMessage || (evaluationResult.status === 'success' ? `${evaluationResult.items.length} 个评分项` : '等待开始评标')}</small>
          </div>
          <button type="button" className="primary-action" onClick={() => void startEvaluation()} disabled={!hasImported || evaluationRunning}>
            {evaluationRunning ? '评标中...' : hasResult ? '重新评标' : '开始评标'}
          </button>
        </section>

        <section className="rejection-reader-card analysis-markdown-card">
          <div className="analysis-result-head rejection-reader-head">
            <strong>评标进度</strong>
            <span>{evaluationResult.progressMessage || (evaluationResult.status === 'success' ? '评标已完成' : evaluationResult.status === 'error' ? '评标失败' : '等待开始评标')}</span>
          </div>

          <div style={{ padding: '18px 22px', display: 'grid', gap: 14 }}>
            <ProgressBar value={progress} label={`评标进度 ${progress}%`} active={evaluationRunning} tone={evaluationRunning ? 'primary' : 'success'} />

            {evaluationResult.status === 'error' && (
              <div className="markdown-empty-state rejection-finding-empty is-error">
                <strong>{evaluationResult.error || '评标失败'}</strong>
                <p>请确认模型配置可用，或重新导入方案后再次评标。</p>
                <button type="button" className="secondary-action" onClick={() => void startEvaluation()} disabled={evaluationRunning || !hasImported}>
                  重新评标
                </button>
              </div>
            )}

            {evaluationTask && evaluationTask.logs.length > 0 && (
              <div className="evaluation-log-list" style={{ display: 'grid', gap: 6 }}>
                {evaluationTask.logs.map((log, index) => (
                  <div key={`${index}-${log}`} style={{ color: 'var(--yb-text-muted)', fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all' }}>
                    {log}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </>
    );
  }

  function renderResultsStep() {
    const { status, totalScore, totalMaxScore, items, overallComment } = evaluationResult;
    return (
      <>
        <div className="rejection-check-result-title">
          <div>
            <span className="section-kicker">STEP 03</span>
            <h2 style={{ margin: '8px 0 0', letterSpacing: '-0.025em' }}>评标结果</h2>
          </div>
        </div>

        <section className="rejection-result-command-bar">
          <div>
            <span className="section-kicker">总分</span>
            <strong style={{ fontSize: 28 }}>{formatScore(totalScore)}<small style={{ fontSize: 16, fontWeight: 700, color: 'var(--yb-text-muted)' }}> / {formatScore(totalMaxScore)}</small></strong>
            <p>得分率 {scoreRatePercent}%</p>
          </div>
          <div className={`rejection-result-status is-${status}`}>
            <span>{runStatusLabels[status]}</span>
            <small>{status === 'success' ? `${items.length} 个评分项` : evaluationResult.progressMessage || '等待评标'}</small>
          </div>
          <button type="button" className="primary-action" onClick={() => switchStep('items')} disabled={evaluationRunning}>
            {evaluationRunning ? '评标中...' : '重新评标'}
          </button>
        </section>

        <section className="rejection-reader-card analysis-markdown-card">
          <div className="analysis-result-head rejection-reader-head">
            <strong>总体评语</strong>
            <span>{status === 'success' ? '由 AI 汇总生成' : '等待评标'}</span>
          </div>
          <div className="markdown-viewer" style={{ padding: '18px 22px', minHeight: 0, overflow: 'auto' }}>
            <MarkdownRenderer>{overallComment || '暂无总体评语'}</MarkdownRenderer>
          </div>
        </section>

        {items.length > 0 ? (
          <div className="rejection-finding-list">
            {items.map((item, index) => (
              <EvaluationScoreItemCard
                key={item.id}
                item={item}
                index={index}
                expanded={evaluationResult.activeItemId === item.id}
                onToggle={() => toggleScoreItem(item.id)}
              />
            ))}
          </div>
        ) : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>{status === 'running' ? '评标进行中' : status === 'error' ? '评标失败' : '等待评标结果'}</strong>
            <p>{status === 'running' ? (evaluationResult.progressMessage || 'AI 正在逐项打分。') : status === 'error' ? (evaluationResult.error || '请重新评标。') : '完成评标后，这里会展示每个评分项的得分明细。'}</p>
          </div>
        )}
      </>
    );
  }

  const canGoNext = step === 'documents' ? hasImported : step === 'items' ? hasResult : false;

  const toolbarGroups: FloatingToolbarGroup[] = [
    ...(step === 'results' ? [{
      id: 'evaluation-export',
      actions: [{
        id: 'export-excel',
        label: exporting ? '导出中...' : '导出 Excel',
        icon: <ToolbarDocumentIcon />,
        variant: 'success' as const,
        disabled: exporting || !hasExportableResult,
        tooltip: !hasExportableResult ? '请先完成一次评标再导出' : '导出评标概览与评分明细',
        onClick: () => { void exportExcel(); },
      }],
    }] : []),
    {
      id: 'evaluation-reset',
      actions: [
        {
          id: 'reset',
          label: '清空',
          variant: 'danger',
          disabled: (!hasImported && !hasResult && step === 'documents') || evaluationRunning,
          tooltip: '清空当前评标数据',
          onClick: resetWorkspace,
        },
        {
          id: 'home',
          label: '返回',
          variant: step === 'documents' ? 'primary' : 'secondary',
          disabled: evaluationRunning,
          tooltip: evaluationRunning ? '请等待当前评标结束后再返回' : '回到导入方案',
          onClick: () => switchStep('documents'),
        },
      ],
    },
    {
      id: 'evaluation-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0 || evaluationRunning,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: activeIndex >= steps.length - 1 || !canGoNext || evaluationRunning,
          tooltip: activeIndex >= steps.length - 1
            ? '当前已经是最后一步'
            : !canGoNext
              ? step === 'documents' ? '请先导入方案' : '请先完成评标'
              : `进入${stepLabels[steps[activeIndex + 1]]}`,
          onClick: () => goToOffset(1),
        },
      ],
    },
  ];

  return (
    <div
      className={`evaluation-page is-${step}`}
      style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, position: 'relative', overflow: 'hidden' }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {step === 'documents' ? renderDocumentsStep() : step === 'items' ? renderItemsStep() : renderResultsStep()}
      </div>

      <AppDialog
        open={Boolean(exportedExcelPath)}
        onOpenChange={(open) => !open && setExportedExcelPath('')}
        kicker="导出完成"
        title="评标结果已导出"
        description={exportedExcelPath ? `文件已保存到：${exportedExcelPath}` : undefined}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setExportedExcelPath('')}>稍后打开</button>
            <button type="button" className="primary-action" onClick={() => { void openExportedExcelFile(); }}>打开文件</button>
          </>
        )}
      />

      <FloatingToolbar groups={toolbarGroups} label="AI评标工具条" />
    </div>
  );
}

export default EvaluationPage;
