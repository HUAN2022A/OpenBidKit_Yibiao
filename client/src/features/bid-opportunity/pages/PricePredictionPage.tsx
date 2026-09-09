import { useEffect, useMemo, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  BidOpportunity,
  BidOpportunityPricePrediction,
  BidOpportunityStatus,
  BidOpportunityWorkspaceState,
} from '../types';

interface BidOpportunityApi {
  loadState: () => Promise<BidOpportunityWorkspaceState>;
  readAnnouncement: (opportunityId: string) => Promise<string>;
  saveUiState: (payload: Partial<BidOpportunityWorkspaceState>) => Promise<void>;
}

interface TasksApi {
  startBidOpportunityPrice: (payload: unknown) => Promise<unknown>;
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

const confidenceLabels: Record<string, string> = {
  high: '把握度高',
  medium: '把握度中',
  low: '把握度低',
};

function PricePredictionPage() {
  const { showToast } = useToast();
  const [workspace, setWorkspace] = useState<BidOpportunityWorkspaceState | null>(null);

  const activeOpportunity = useMemo(() => {
    const opportunities = workspace?.opportunities ?? [];
    return opportunities.find((item) => item.id === workspace?.activeOpportunityId) || opportunities[0] || null;
  }, [workspace?.opportunities, workspace?.activeOpportunityId]);

  const priceRunning = workspace?.priceTask?.status === 'running';

  useEffect(() => {
    trackPageView('bid-opportunity-price');
  }, []);

  useEffect(() => {
    let canceled = false;
    const api = getBidOpportunityApi();
    if (!api) return;
    void api.loadState()
      .then((state) => {
        if (canceled || !state) return;
        setWorkspace(state);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取投标机会缓存失败', 'error');
      });
    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    const tasks = getTasksApi();
    if (!tasks) return;
    const unsubscribe = tasks.onTaskEvent((rawEvent) => {
      const event = rawEvent as { bidOpportunityPatch?: unknown };
      const patch = (event.bidOpportunityPatch ?? {}) as Partial<BidOpportunityWorkspaceState>;
      if (!patch || typeof patch !== 'object') return;
      setWorkspace((prev) => {
        if (!prev) return prev;
        const next: BidOpportunityWorkspaceState = { ...prev };
        if (patch.priceTask) next.priceTask = patch.priceTask;
        if (patch.opportunities) next.opportunities = patch.opportunities;
        return next;
      });
    });
    void tasks.getActiveTasks().catch(() => undefined);
    return unsubscribe;
  }, []);

  const handleSelectOpportunity = async (id: string) => {
    const api = getBidOpportunityApi();
    if (!api) return;
    await api.saveUiState({ activeOpportunityId: id });
    setWorkspace((prev) => (prev ? { ...prev, activeOpportunityId: id } : prev));
  };

  const handlePrice = async () => {
    if (!activeOpportunity) return;
    const tasks = getTasksApi();
    if (!tasks) {
      showToast('后台任务接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    try {
      await tasks.startBidOpportunityPrice({ opportunityId: activeOpportunity.id });
      showToast('报价预测任务已启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动报价预测失败', 'error');
    }
  };

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'price',
      actions: [
        {
          id: 'price',
          label: priceRunning ? '预测中...' : activeOpportunity?.pricePrediction ? '重新预测' : '报价预测',
          variant: 'primary',
          disabled: priceRunning || !activeOpportunity?.structured,
          onClick: () => void handlePrice(),
        },
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
          <strong>报价预测</strong>
          <p>基于公告与行业常识估算对手报价，给出建议报价区间与报价策略。</p>
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
                <span className="section-kicker">报价预测</span>
                <h3>{activeOpportunity.title}</h3>
                <p>{(activeOpportunity.region || activeOpportunity.tenderer) ? [activeOpportunity.region, activeOpportunity.tenderer].filter(Boolean).join(' · ') : '等待解析'}</p>
              </div>
              <div className="bid-opportunity-detail-actions">
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void handlePrice()}
                  disabled={priceRunning || !activeOpportunity.structured}
                >
                  {priceRunning ? '预测中...' : activeOpportunity.pricePrediction ? '重新预测' : '报价预测'}
                </button>
              </div>
            </header>

            {priceRunning && (
              <ProgressBar
                value={workspace.priceTask?.progress ?? 0}
                active
                label={`报价预测进度 ${workspace.priceTask?.progress ?? 0}%`}
              />
            )}

            {activeOpportunity.pricePrediction ? (
              <PricePredictionSection opportunity={activeOpportunity} />
            ) : (
              <div className="bid-opportunity-empty">
                <strong>{priceRunning ? '正在预测报价' : '尚未预测报价'}</strong>
                <p>{priceRunning ? '后台正在估算对手报价与建议区间，请稍候。' : '点击「报价预测」估算对手报价与建议报价区间。'}</p>
              </div>
            )}
          </article>
        ) : (
          <div className="bid-opportunity-empty-detail">
            <strong>选择或创建一个投标机会</strong>
            <p>导入招标公告后，AI 会解析结构化信息并给出报价预测。</p>
          </div>
        )}
      </section>

      <FloatingToolbar groups={toolbarGroups} label="报价预测工具条" />
    </div>
  );
}

function PricePredictionSection({ opportunity }: { opportunity: BidOpportunity }) {
  const prediction = opportunity.pricePrediction as BidOpportunityPricePrediction | null;
  if (!prediction) return null;

  if (prediction.status === 'error') {
    return (
      <section className="bid-opportunity-panel bid-opportunity-price">
        <div className="bid-opportunity-panel-head">
          <div>
            <span className="section-kicker">报价预测</span>
            <h3>预测失败</h3>
          </div>
        </div>
        <p className="bid-opportunity-empty">{prediction.error || '报价预测失败，请重试。'}</p>
      </section>
    );
  }

  const competitors = Array.isArray(prediction.competitors) ? prediction.competitors : [];

  return (
    <section className="bid-opportunity-panel bid-opportunity-price">
      <div className="bid-opportunity-panel-head">
        <div>
          <span className="section-kicker">报价预测</span>
          <h3>对手报价与报价建议</h3>
        </div>
        {prediction.winProbability ? (
          <div className="bid-opportunity-price-recommend">
            <em>预计中标概率</em>
            <strong>{prediction.winProbability}</strong>
          </div>
        ) : null}
      </div>

      <div className="price-recommend-card">
        <dl className="structured-grid">
          <div>
            <dt>我方建议报价</dt>
            <dd>{prediction.recommendedPrice || '—'}</dd>
          </div>
          <div>
            <dt>建议报价区间</dt>
            <dd>{prediction.recommendedPriceRange || '—'}</dd>
          </div>
        </dl>
        {prediction.strategy ? (
          <div className="bid-opportunity-analysis">
            <span className="section-kicker">报价策略</span>
            <MarkdownRenderer allowRawHtml={false}>{prediction.strategy}</MarkdownRenderer>
          </div>
        ) : null}
      </div>

      {competitors.length ? (
        <div className="price-competitor-list">
          {competitors.map((competitor) => (
            <article key={competitor.id} className="price-competitor-row">
              <div className="price-competitor-head">
                <strong>{competitor.name}</strong>
                <em className={`confidence-badge is-${competitor.confidence}`}>{confidenceLabels[competitor.confidence] || competitor.confidence}</em>
              </div>
              <dl className="structured-grid">
                <div>
                  <dt>预测报价</dt>
                  <dd>{competitor.predictedPrice || '—'}</dd>
                </div>
                <div>
                  <dt>预测区间</dt>
                  <dd>{competitor.predictedPriceRange || '—'}</dd>
                </div>
              </dl>
              {competitor.rationale ? <p className="price-competitor-rationale">{competitor.rationale}</p> : null}
            </article>
          ))}
        </div>
      ) : null}

      {prediction.overallComment ? (
        <div className="bid-opportunity-analysis">
          <span className="section-kicker">总体说明</span>
          <MarkdownRenderer allowRawHtml={false}>{prediction.overallComment}</MarkdownRenderer>
        </div>
      ) : null}

      <p className="price-prediction-disclaimer">以上为基于公告与行业常识的参考性估算，非真实竞对数据，仅供报价参考。</p>
    </section>
  );
}

export default PricePredictionPage;
