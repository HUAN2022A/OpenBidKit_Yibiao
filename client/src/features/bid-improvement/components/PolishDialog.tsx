import { useEffect, useMemo, useRef, useState } from 'react';
import { AppDialog, ProgressBar, useToast } from '../../../shared/ui';
import ComparisonView from './ComparisonView';

/**
 * 标书润色对话框（bid-improvement / polish）。
 *
 * 面向「完成态标书提质」场景：对已选中的技术方案正文小节做表达层面润色。
 * 内部状态机：form（配置）→ polishing（后台任务执行中，展示进度条）→ comparison（结果对比）。
 *
 * 后台任务由 `window.yibiao.tasks.startBidImprovementPolish` 启动，进度/状态/错误经
 * `window.yibiao.tasks.onTaskEvent` 推送，按任务类型 `bid-improvement-polish` 过滤。
 * 润色结果从成功事件的 `task.stats.results` 读取（对应 bidImprovementPolishTask 的
 * 返回值 `{ nodeId, originalContent, polishedContent }[]`，由 taskService checkpoint 进
 * 任务 stats 后随事件下发）。
 */

/** 单个小节的润色结果，与 bidImprovementPolishTask 的返回值保持一致。 */
export interface PolishResult {
  nodeId: string;
  originalContent: string;
  polishedContent: string;
}

/** ComparisonView 的对外约定，供并行的对比视图组件对齐实现。 */
export interface ComparisonViewProps {
  results: PolishResult[];
  /** 本次润色目标（中文标签），随采纳 / 拒绝一起写入润色历史。 */
  polishGoal: string;
  onBack: () => void;
  onClose: () => void;
}

export interface PolishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 需要润色的正文小节 nodeId 列表。 */
  nodeIds: string[];
  /** 选中内容的只读预览（通常是所选小节正文的拼接）。 */
  selectedContent: string;
  /** 润色完成后可选回调，便于父组件同步结果或埋点。 */
  onComplete?: (results: PolishResult[]) => void;
}

/** 润色目标选项：value 直接作为 payload.polishGoal 传给后台任务，后台按中文关键词匹配指导语。 */
const POLISH_GOALS = [
  { value: '专业性', label: '专业性', hint: '行业术语规范、表述严谨、层次清晰' },
  { value: '简洁性', label: '简洁性', hint: '删除套话与冗余，要点突出、文字精炼' },
  { value: '合规性', label: '合规性', hint: '表述稳妥、不夸大、消除废标风险措辞' },
] as const;

type PolishGoal = (typeof POLISH_GOALS)[number]['value'];

const TASK_TYPE = 'bid-improvement-polish';

type Phase = 'form' | 'polishing' | 'comparison';

interface PolishTaskEventTask {
  task_id: string;
  type: string;
  status: string;
  progress: number;
  logs: string[];
  error?: string;
  stats?: { results?: PolishResult[] } | null;
}

interface PolishTaskEvent {
  task?: PolishTaskEventTask;
}

interface TasksApi {
  startBidImprovementPolish: (payload: unknown) => Promise<unknown>;
  getActiveTasks: () => Promise<Array<{ type?: string; status?: string; progress?: number; logs?: string[] }>>;
  onTaskEvent: (callback: (event: unknown) => void) => () => void;
}

function getTasksApi(): TasksApi | undefined {
  const bridge = window.yibiao as unknown as { tasks?: TasksApi };
  return bridge?.tasks;
}

export default function PolishDialog({
  open,
  onOpenChange,
  nodeIds,
  selectedContent,
  onComplete,
}: PolishDialogProps) {
  const { showToast } = useToast();

  const [phase, setPhase] = useState<Phase>('form');
  const [polishGoal, setPolishGoal] = useState<PolishGoal>('专业性');
  const [tenderContext, setTenderContext] = useState('');
  const [progress, setProgress] = useState(0);
  const [currentLog, setCurrentLog] = useState('');
  const [results, setResults] = useState<PolishResult[] | null>(null);

  // 用 ref 承载 onComplete，避免订阅因父组件回调引用变化而反复重建。
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const previewText = useMemo(() => selectedContent.trim(), [selectedContent]);
  const canStart = previewText.length > 0 && nodeIds.length > 0;

  // 打开时重置为表单态，并回放当前是否已有正在执行的润色任务。
  useEffect(() => {
    if (!open) return;
    setPhase('form');
    setPolishGoal('专业性');
    setTenderContext('');
    setProgress(0);
    setCurrentLog('');
    setResults(null);

    const tasks = getTasksApi();
    if (!tasks?.getActiveTasks) return;
    let canceled = false;
    void tasks
      .getActiveTasks()
      .then((list) => {
        if (canceled) return;
        const active = (Array.isArray(list) ? list : []).find((task) => task?.type === TASK_TYPE);
        if (!active) return;
        setPhase('polishing');
        setProgress(typeof active.progress === 'number' ? active.progress : 0);
        setCurrentLog(Array.isArray(active.logs) && active.logs.length ? active.logs[active.logs.length - 1] : '');
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [open]);

  // 订阅润色任务事件，驱动进度条与状态切换。
  useEffect(() => {
    if (!open) return;
    const tasks = getTasksApi();
    if (!tasks?.onTaskEvent) return;
    const unsubscribe = tasks.onTaskEvent((rawEvent) => {
      const event = rawEvent as PolishTaskEvent;
      const task = event?.task;
      if (!task || task.type !== TASK_TYPE) return;

      setProgress(typeof task.progress === 'number' ? task.progress : 0);
      setCurrentLog(Array.isArray(task.logs) && task.logs.length ? task.logs[task.logs.length - 1] : '');

      if (task.status === 'running' || task.status === 'pausing' || task.status === 'paused') {
        setPhase('polishing');
      } else if (task.status === 'success') {
        const nextResults = Array.isArray(task.stats?.results) ? task.stats.results : [];
        setResults(nextResults);
        setPhase('comparison');
        onCompleteRef.current?.(nextResults);
      } else if (task.status === 'error') {
        setPhase('form');
        showToast(task.error || '润色失败，请稍后重试', 'error');
      }
    });
    return unsubscribe;
  }, [open, showToast]);

  const handleStart = async () => {
    const tasks = getTasksApi();
    if (!tasks?.startBidImprovementPolish) {
      showToast('润色接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (!nodeIds.length) {
      showToast('请选择需要润色的正文小节', 'info');
      return;
    }
    if (!previewText) {
      showToast('所选小节没有可润色的正文内容', 'info');
      return;
    }
    setResults(null);
    setProgress(0);
    setCurrentLog('');
    try {
      await tasks.startBidImprovementPolish({
        nodeIds,
        polishGoal,
        tenderContext: tenderContext.trim(),
      });
      setPhase('polishing');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '润色任务启动失败', 'error');
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleBackToForm = () => {
    setResults(null);
    setProgress(0);
    setCurrentLog('');
    setPhase('form');
  };

  const title = phase === 'comparison' ? '润色结果对比' : '标书润色';

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={phase === 'comparison' ? '润色完成' : undefined}
      title={title}
      description={
        phase === 'comparison'
          ? '对照查看各小节的润色前后内容，确认后即可回填。'
          : '在不改动事实、数据与承诺的前提下，提升所选正文的表达质量。'
      }
      preventClose={phase === 'polishing'}
      cardClassName="polish-dialog-card"
      actions={
        phase === 'form' ? (
          <>
            <button type="button" className="secondary-action" onClick={handleClose}>
              取消
            </button>
            <button type="button" className="primary-action" onClick={handleStart} disabled={!canStart}>
              开始润色
            </button>
          </>
        ) : phase === 'polishing' ? (
          <button type="button" className="primary-action" disabled>
            润色中…
          </button>
        ) : undefined
      }
    >
      {phase === 'form' && (
        <div className="polish-dialog-form">
          <div className="polish-dialog-field">
            <span className="polish-dialog-label">润色目标</span>
            <div className="polish-goal-list" role="radiogroup" aria-label="润色目标">
              {POLISH_GOALS.map((goal) => {
                const isActive = goal.value === polishGoal;
                return (
                  <button
                    key={goal.value}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    className={`polish-goal-option${isActive ? ' is-active' : ''}`}
                    onClick={() => setPolishGoal(goal.value)}
                  >
                    <span className="polish-goal-title">{goal.label}</span>
                    <span className="polish-goal-hint">{goal.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="polish-dialog-field">
            <span className="polish-dialog-label">招标要求（可选）</span>
            <textarea
              className="polish-dialog-textarea"
              value={tenderContext}
              onChange={(event) => setTenderContext(event.target.value)}
              placeholder="粘贴评分要点、实质性条款等招标要求上下文，润色时将优先对齐。"
            />
          </div>

          <div className="polish-dialog-field">
            <span className="polish-dialog-label">预览选中内容</span>
            <div className="polish-preview-content" aria-readonly="true">
              {previewText || <span className="polish-preview-empty">未选中可润色的正文内容</span>}
            </div>
          </div>
        </div>
      )}

      {phase === 'polishing' && (
        <div className="polish-dialog-progress">
          <ProgressBar value={progress} label={`润色进度 ${progress}%`} active />
          <p className="polish-dialog-progress-log">{currentLog || '正在准备润色…'}</p>
        </div>
      )}

      {phase === 'comparison' && results && (
        <ComparisonView results={results} polishGoal={polishGoal} onBack={handleBackToForm} onClose={handleClose} />
      )}
    </AppDialog>
  );
}
