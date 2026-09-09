import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, FloatingToolbar, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  BidOpportunity,
  BidOpportunityKeyDate,
  BidOpportunityStatus,
  BidOpportunityWorkspaceState,
} from '../types';

interface BidOpportunityApi {
  loadState: () => Promise<BidOpportunityWorkspaceState>;
  readAnnouncement: (opportunityId: string) => Promise<string>;
  saveUiState: (payload: Partial<BidOpportunityWorkspaceState>) => Promise<void>;
  importAnnouncement: () => Promise<{ success: boolean; message?: string; opportunityId?: string }>;
  importFromTechnicalPlan: () => Promise<{ success: boolean; message?: string; opportunityIds?: string[] }>;
  importFromUrl: (url: string) => Promise<{ success: boolean; message?: string; opportunityId?: string }>;
  createAnnouncement: (payload: { rawText: string; title?: string }) => Promise<{ success: boolean; message?: string; opportunityId?: string }>;
  updateAnnouncement: (payload: { opportunityId: string; status?: BidOpportunityStatus; owner?: string; conclusion?: string; keyDates?: BidOpportunityKeyDate[] }) => Promise<{ success: boolean; message?: string }>;
  deleteAnnouncement: (payload: { opportunityId: string }) => Promise<{ success: boolean; message?: string }>;
  clear: () => Promise<{ success: boolean; message?: string }>;
}

interface TasksApi {
  startBidOpportunityParse: (payload: unknown) => Promise<unknown>;
  startBidOpportunityScore: (payload: unknown) => Promise<unknown>;
  getActiveTasks: () => Promise<Array<{ type?: string }>>;
  onTaskEvent: (callback: (event: unknown) => void) => () => void;
}

function getBidOpportunityApi(): BidOpportunityApi | undefined {
  const bridge = window.yibiao as unknown as { bidOpportunity?: BidOpportunityApi };
  return bridge?.bidOpportunity;
}

function getTasksApi(): TasksApi | undefined {
  const bridge = window.yibiao as unknown as { tasks?: TasksApi };
  return bridge?.tasks;
}

const statusLabels: Record<BidOpportunityStatus, string> = {
  new: '新入库',
  screening: '初筛中',
  following: '跟进中',
  bidding: '投标中',
  abandoned: '已放弃',
};

const parseStatusLabels: Record<string, string> = {
  idle: '待解析',
  running: '解析中',
  success: '已解析',
  error: '解析失败',
};

const recommendationLabels: Record<string, string> = {
  bid: '建议投',
  evaluate: '需评估',
  skip: '不建议投',
};

function normalizeState(state: unknown): BidOpportunityWorkspaceState {
  const source = (state && typeof state === 'object' ? state : {}) as Partial<BidOpportunityWorkspaceState>;
  return {
    enterprise: source.enterprise || { companyName: '', industry: '', regions: [], strengths: '' },
    qualifications: Array.isArray(source.qualifications) ? source.qualifications : [],
    performances: Array.isArray(source.performances) ? source.performances : [],
    opportunities: Array.isArray(source.opportunities) ? source.opportunities : [],
    activeOpportunityId: source.activeOpportunityId ?? null,
    activeTab: 'opportunities',
    parseTask: source.parseTask,
    scoreTask: source.scoreTask,
    priceTask: source.priceTask,
  };
}

function BidOpportunityPage() {
  const { showToast } = useToast();
  const [workspace, setWorkspace] = useState<BidOpportunityWorkspaceState | null>(null);
  const [rawText, setRawText] = useState('');
  const [rawTextLoading, setRawTextLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createText, setCreateText] = useState('');
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BidOpportunity | null>(null);
  const hydratedRef = useRef(false);
  const activeTaskTypesRef = useRef<Set<string>>(new Set());

  const activeOpportunity = useMemo(() => {
    const opportunities = workspace?.opportunities ?? [];
    return opportunities.find((item) => item.id === workspace?.activeOpportunityId) || opportunities[0] || null;
  }, [workspace?.opportunities, workspace?.activeOpportunityId]);

  const parseRunning = workspace?.parseTask?.status === 'running';
  const scoreRunning = workspace?.scoreTask?.status === 'running';
  const runningTask = parseRunning
    ? workspace?.parseTask
    : scoreRunning
      ? workspace?.scoreTask
      : null;

  const applyWorkspaceState = useCallback((state: unknown) => {
    setWorkspace(normalizeState(state));
  }, []);

  const applyWorkspacePatch = useCallback((patch: unknown) => {
    setWorkspace((prev) => ({ ...normalizeState(prev), ...normalizeState(patch) }));
  }, []);

  const reload = useCallback(async () => {
    const api = getBidOpportunityApi();
    if (!api) return;
    const state = await api.loadState();
    applyWorkspaceState(state);
  }, [applyWorkspaceState]);

  useEffect(() => {
    trackPageView('bid-opportunity-discovery');
  }, []);

  useEffect(() => {
    let canceled = false;
    const api = getBidOpportunityApi();
    if (!api) {
      hydratedRef.current = true;
      return;
    }
    void api.loadState()
      .then((state) => {
        if (canceled || !state) return;
        applyWorkspaceState(state);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取投标机会缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) hydratedRef.current = true;
      });
    return () => {
      canceled = true;
    };
  }, [applyWorkspaceState, showToast]);

  useEffect(() => {
    const tasks = getTasksApi();
    if (!tasks) return;
    const unsubscribe = tasks.onTaskEvent((rawEvent) => {
      const event = rawEvent as { bidOpportunity?: unknown; bidOpportunityPatch?: unknown };
      if (event.bidOpportunity) applyWorkspaceState(event.bidOpportunity);
      if (event.bidOpportunityPatch) applyWorkspacePatch(event.bidOpportunityPatch);
    });
    void tasks.getActiveTasks()
      .then((list) => {
        const activeTypes = new Set((Array.isArray(list) ? list : [])
          .map((task) => (task && typeof task.type === 'string' ? task.type : '')));
        activeTaskTypesRef.current = activeTypes;
      })
      .catch((error) => {
        console.warn('获取投标机会后台任务状态失败', error);
      });
    return unsubscribe;
  }, [applyWorkspaceState, applyWorkspacePatch]);

  useEffect(() => {
    if (!activeOpportunity) {
      setRawText('');
      return;
    }
    let canceled = false;
    setRawTextLoading(true);
    const api = getBidOpportunityApi();
    if (!api) {
      setRawTextLoading(false);
      return;
    }
    void api.readAnnouncement(activeOpportunity.id)
      .then((content) => {
        if (!canceled) setRawText(content || '');
      })
      .catch(() => {
        if (!canceled) setRawText('');
      })
      .finally(() => {
        if (!canceled) setRawTextLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [activeOpportunity?.id]);

  const handleImport = async () => {
    const api = getBidOpportunityApi();
    if (!api) {
      showToast('投标机会接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (importing) return;
    setImporting(true);
    try {
      const result = await api.importAnnouncement();
      if (!result?.success) {
        showToast(result?.message || '公告导入失败', 'info');
        return;
      }
      await reload();
      showToast(result.message || '公告已导入', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '公告导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleImportFromTechnicalPlan = async () => {
    const api = getBidOpportunityApi();
    if (!api) {
      showToast('投标机会接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (importing) return;
    setImporting(true);
    try {
      const result = await api.importFromTechnicalPlan();
      if (!result?.success) {
        showToast(result?.message || '从技术方案导入失败', 'info');
        return;
      }
      await reload();
      showToast(result.message || '已从技术方案导入', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '从技术方案导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleCreate = async () => {
    const api = getBidOpportunityApi();
    if (!api) return;
    const text = createText.trim();
    if (!text) {
      showToast('请粘贴公告内容', 'info');
      return;
    }
    try {
      const result = await api.createAnnouncement({ rawText: text, title: createTitle.trim() || undefined });
      if (!result?.success) {
        showToast(result?.message || '公告创建失败', 'info');
        return;
      }
      setCreateOpen(false);
      setCreateTitle('');
      setCreateText('');
      await reload();
      showToast(result.message || '公告已创建', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '公告创建失败', 'error');
    }
  };

  const handleImportFromUrl = async () => {
    const url = urlInput.trim();
    if (!url) {
      showToast('请输入链接', 'info');
      return;
    }
    const api = getBidOpportunityApi();
    if (!api) {
      showToast('投标机会接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    if (importing) return;
    setImporting(true);
    try {
      const result = await api.importFromUrl(url);
      if (!result?.success) {
        showToast(result?.message || '导入失败', 'info');
        return;
      }
      setUrlDialogOpen(false);
      setUrlInput('');
      await reload();
      showToast(result.message || '已从链接导入公告', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleSelectOpportunity = async (id: string) => {
    const api = getBidOpportunityApi();
    if (!api) return;
    await api.saveUiState({ activeOpportunityId: id });
    setWorkspace((prev) => (prev ? { ...prev, activeOpportunityId: id } : prev));
  };

  const handleUpdateStatus = async (status: BidOpportunityStatus) => {
    if (!activeOpportunity) return;
    const api = getBidOpportunityApi();
    if (!api) return;
    try {
      const result = await api.updateAnnouncement({ opportunityId: activeOpportunity.id, status });
      if (!result?.success) showToast(result?.message || '更新失败', 'info');
      else await reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '更新失败', 'error');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const api = getBidOpportunityApi();
    if (!api) return;
    try {
      const result = await api.deleteAnnouncement({ opportunityId: deleteTarget.id });
      setDeleteTarget(null);
      await reload();
      if (result?.success) showToast('机会已删除', 'success');
    } catch (error) {
      setDeleteTarget(null);
      showToast(error instanceof Error ? error.message : '删除失败', 'error');
    }
  };

  const handleParse = async () => {
    if (!activeOpportunity) return;
    const tasks = getTasksApi();
    if (!tasks) {
      showToast('后台任务接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    try {
      await tasks.startBidOpportunityParse({ opportunityId: activeOpportunity.id });
      showToast('公告解析任务已启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动公告解析失败', 'error');
    }
  };

  const handleScore = async () => {
    if (!activeOpportunity) return;
    const tasks = getTasksApi();
    if (!tasks) {
      showToast('后台任务接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    try {
      await tasks.startBidOpportunityScore({ opportunityId: activeOpportunity.id });
      showToast('匹配评分任务已启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动匹配评分失败', 'error');
    }
  };

  const handleSaveTracking = useCallback((payload: { owner?: string; conclusion?: string; keyDates?: BidOpportunityKeyDate[] }) => {
    if (!activeOpportunity) return;
    const api = getBidOpportunityApi();
    if (!api) return;
    void api.updateAnnouncement({ opportunityId: activeOpportunity.id, ...payload })
      .then((result) => {
        if (!result?.success) showToast(result?.message || '保存失败', 'info');
        else void reload();
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '保存失败', 'error'));
  }, [activeOpportunity, reload, showToast]);

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'main',
      actions: [
        { id: 'import', label: importing ? '导入中...' : '导入公告', variant: 'secondary', disabled: importing, onClick: () => void handleImport() },
        { id: 'import-from-plan', label: '从技术方案导入', variant: 'secondary', onClick: () => void handleImportFromTechnicalPlan() },
        { id: 'create', label: '新建公告', variant: 'secondary', onClick: () => setCreateOpen(true) },
        { id: 'import-from-url', label: '从链接导入', variant: 'secondary', onClick: () => setUrlDialogOpen(true) },
      ],
    },
  ];

  if (!workspace) {
    return <div className="bid-opportunity-page" />;
  }

  return (
    <div className="bid-opportunity-page">
      <section className="bid-opportunity-command-bar">
        <div>
          <span className="section-kicker">投标机会</span>
          <strong>机会发现与线索跟踪</strong>
          <p>导入招标公告，AI 解析结构化信息，匹配企业画像并给出投前评分建议。</p>
        </div>
      </section>

      <section className="bid-opportunity-workspace">
        <aside className="bid-opportunity-list-panel" aria-label="机会列表">
          <div className="bid-opportunity-panel-head">
            <div>
              <span className="section-kicker">机会列表</span>
              <h3>近期机会</h3>
            </div>
          </div>
          <div className="bid-opportunity-list">
            {workspace.opportunities.length ? workspace.opportunities.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`bid-opportunity-item${item.id === activeOpportunity?.id ? ' is-active' : ''}`}
                onClick={() => void handleSelectOpportunity(item.id)}
              >
                <strong>{item.title}</strong>
                <span>{(item.region || item.tenderer) ? [item.region, item.tenderer].filter(Boolean).join(' · ') : '未解析'}</span>
                <small>
                  <em className={`status-badge is-${item.status}`}>{statusLabels[item.status] || item.status}</em>
                  {item.score ? <em className="score-badge">{item.score.totalScore} 分</em> : null}
                </small>
              </button>
            )) : (
              <div className="bid-opportunity-empty-list">
                <strong>暂无投标机会</strong>
                <p>点击顶部「导入公告」或「新建公告」开始。</p>
              </div>
            )}
          </div>
        </aside>

        {activeOpportunity ? (
          <article className="bid-opportunity-detail">
            <header className="bid-opportunity-detail-head">
              <div>
                <span className="section-kicker">机会详情</span>
                <h3>{activeOpportunity.title}</h3>
                <p>{(activeOpportunity.region || activeOpportunity.tenderer) ? [activeOpportunity.region, activeOpportunity.tenderer].filter(Boolean).join(' · ') : '等待解析'}</p>
              </div>
              <div className="bid-opportunity-detail-actions">
                <select
                  value={activeOpportunity.status}
                  onChange={(event) => void handleUpdateStatus(event.target.value as BidOpportunityStatus)}
                  aria-label="机会状态"
                >
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <button type="button" className="danger-action" onClick={() => setDeleteTarget(activeOpportunity)}>删除</button>
              </div>
            </header>

            <div className="bid-opportunity-detail-command">
              <button
                type="button"
                className="primary-action"
                onClick={() => void handleParse()}
                disabled={parseRunning || scoreRunning || !activeOpportunity}
              >
                {parseRunning ? '解析中...' : activeOpportunity.parseStatus === 'success' ? '重新解析' : '解析公告'}
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void handleScore()}
                disabled={parseRunning || scoreRunning || !activeOpportunity.structured}
              >
                {scoreRunning ? '评分中...' : activeOpportunity.score ? '重新评分' : '匹配评分'}
              </button>
              <span className="parse-status-text">{parseStatusLabels[activeOpportunity.parseStatus] || activeOpportunity.parseStatus}</span>
              {runningTask && (
                <ProgressBar
                  value={runningTask.progress ?? 0}
                  active
                  label={`后台任务进度 ${runningTask.progress ?? 0}%`}
                />
              )}
            </div>

            {activeOpportunity.structured ? (
              <StructuredSection opportunity={activeOpportunity} />
            ) : (
              <div className="bid-opportunity-empty">
                <strong>{parseRunning ? '正在解析公告' : '尚未解析'}</strong>
                <p>{parseRunning ? '后台正在提取结构化信息，请稍候。' : '点击「解析公告」提取项目名称、预算、资质要求等结构化信息。'}</p>
              </div>
            )}

            {activeOpportunity.score ? (
              <ScoreSection opportunity={activeOpportunity} />
            ) : null}

            <TrackingSection opportunity={activeOpportunity} onSave={handleSaveTracking} />

            <details className="bid-opportunity-raw">
              <summary>公告原文（{activeOpportunity.rawChars} 字）</summary>
              <div className="bid-opportunity-raw-body">
                {rawTextLoading ? <p>加载中...</p> : <MarkdownRenderer allowRawHtml={false}>{rawText || '（无原文）'}</MarkdownRenderer>}
              </div>
            </details>
          </article>
        ) : (
          <div className="bid-opportunity-empty-detail">
            <strong>选择或创建一个投标机会</strong>
            <p>导入招标公告后，AI 会解析结构化信息并给出投前评分。</p>
          </div>
        )}
      </section>

      <FloatingToolbar groups={toolbarGroups} label="投标机会工具条" />

      <AppDialog open={createOpen} onOpenChange={setCreateOpen} title="新建公告">
        <div className="bid-opportunity-create-form">
          <label>
            <span>项目名称（可选）</span>
            <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="留空则由 AI 解析" />
          </label>
          <label>
            <span>公告正文</span>
            <textarea
              value={createText}
              onChange={(event) => setCreateText(event.target.value)}
              placeholder="粘贴招标公告全文"
              rows={10}
            />
          </label>
        </div>
        <div className="content-regenerate-actions">
          <button type="button" className="secondary-action" onClick={() => setCreateOpen(false)}>取消</button>
          <button type="button" className="primary-action" onClick={() => void handleCreate()}>创建</button>
        </div>
      </AppDialog>

      <AppDialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen} title="从链接导入">
        <div className="bid-opportunity-create-form">
          <label>
            <span>招标公告链接</span>
            <input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="粘贴 http/https 招标公告链接" />
          </label>
        </div>
        <div className="content-regenerate-actions">
          <button type="button" className="secondary-action" onClick={() => setUrlDialogOpen(false)}>取消</button>
          <button type="button" className="primary-action" onClick={() => void handleImportFromUrl()} disabled={importing}>{importing ? '导入中...' : '获取'}</button>
        </div>
      </AppDialog>

      <AppDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} title="删除机会">
        <p>确定删除「{deleteTarget?.title}」吗？删除后无法恢复。</p>
        <div className="content-regenerate-actions">
          <button type="button" className="secondary-action" onClick={() => setDeleteTarget(null)}>取消</button>
          <button type="button" className="danger-action" onClick={() => void handleDelete()}>删除</button>
        </div>
      </AppDialog>
    </div>
  );
}

function StructuredSection({ opportunity }: { opportunity: BidOpportunity }) {
  const structured = opportunity.structured;
  if (!structured) return null;
  const rows = [
    ['招标人', structured.tenderer],
    ['预算', structured.budget],
    ['地区', structured.region],
    ['截标时间', structured.deadline],
    ['资质要求', structured.qualificationRequirements],
    ['业绩要求', structured.performanceRequirements],
    ['评标办法', structured.scoringMethod],
  ];
  return (
    <section className="bid-opportunity-panel bid-opportunity-structured">
      <div className="bid-opportunity-panel-head">
        <div>
          <span className="section-kicker">结构化信息</span>
          <h3>公告解析结果</h3>
        </div>
      </div>
      <dl className="structured-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ScoreSection({ opportunity }: { opportunity: BidOpportunity }) {
  const score = opportunity.score;
  if (!score) return null;
  return (
    <section className="bid-opportunity-panel bid-opportunity-score">
      <div className="bid-opportunity-panel-head">
        <div>
          <span className="section-kicker">匹配评分</span>
          <h3>投前评分</h3>
        </div>
        <div className="bid-opportunity-score-total">
          <strong>{score.totalScore}</strong>
          <span>综合分</span>
          {opportunity.recommendation ? <em>{recommendationLabels[opportunity.recommendation] || opportunity.recommendation}</em> : null}
        </div>
      </div>
      <div className="score-dimension-grid">
        {score.dimensions.map((dimension) => (
          <article key={dimension.key}>
            <div>
              <strong>{dimension.label}</strong>
              <em>{dimension.score}</em>
            </div>
            <p>{dimension.note || '—'}</p>
          </article>
        ))}
      </div>
      {opportunity.analysisText ? (
        <div className="bid-opportunity-analysis">
          <span className="section-kicker">投标建议</span>
          <MarkdownRenderer allowRawHtml={false}>{opportunity.analysisText}</MarkdownRenderer>
        </div>
      ) : null}
    </section>
  );
}

function TrackingSection({ opportunity, onSave }: { opportunity: BidOpportunity; onSave: (payload: { owner?: string; conclusion?: string; keyDates?: BidOpportunityKeyDate[] }) => void }) {
  const [owner, setOwner] = useState(opportunity.owner);
  const [conclusion, setConclusion] = useState(opportunity.conclusion);
  const [keyDates, setKeyDates] = useState<BidOpportunityKeyDate[]>(opportunity.keyDates || []);

  useEffect(() => {
    setOwner(opportunity.owner);
    setConclusion(opportunity.conclusion);
    setKeyDates(opportunity.keyDates || []);
  }, [opportunity.id, opportunity.owner, opportunity.conclusion, opportunity.keyDates]);

  const dirty = owner !== opportunity.owner || conclusion !== opportunity.conclusion;

  return (
    <section className="bid-opportunity-panel bid-opportunity-tracking">
      <div className="bid-opportunity-panel-head">
        <div>
          <span className="section-kicker">线索跟踪</span>
          <h3>跟进信息</h3>
        </div>
        <button type="button" className="secondary-action" disabled={!dirty} onClick={() => onSave({ owner, conclusion, keyDates })}>保存线索</button>
      </div>
      <div className="tracking-form-grid">
        <label>
          <span>负责人</span>
          <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="如：张伟" />
        </label>
        <label className="tracking-form-span">
          <span>跟进结论</span>
          <textarea value={conclusion} onChange={(event) => setConclusion(event.target.value)} placeholder="记录跟进结论、否决原因等" rows={3} />
        </label>
      </div>
      <div className="tracking-dates">
        <span className="section-kicker">关键日期</span>
        {keyDates.map((item, index) => (
          <div className="tracking-date-row" key={`${item.label}-${index}`}>
            <input
              value={item.label}
              placeholder="标签（如：开标）"
              onChange={(event) => setKeyDates((prev) => prev.map((row, i) => (i === index ? { ...row, label: event.target.value } : row)))}
            />
            <input
              value={item.date}
              placeholder="日期"
              onChange={(event) => setKeyDates((prev) => prev.map((row, i) => (i === index ? { ...row, date: event.target.value } : row)))}
            />
            <button type="button" className="secondary-action" onClick={() => setKeyDates((prev) => prev.filter((_, i) => i !== index))}>移除</button>
          </div>
        ))}
        <button type="button" className="secondary-action" onClick={() => setKeyDates((prev) => [...prev, { label: '', date: '' }])}>新增日期</button>
      </div>
    </section>
  );
}

export default BidOpportunityPage;
