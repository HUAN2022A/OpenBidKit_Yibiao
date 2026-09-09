import { useEffect, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { FloatingToolbar, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import type {
  BidOpportunityPerformance,
  BidOpportunityQualification,
  BidOpportunityWorkspaceState,
  EnterpriseProfile,
} from '../types';

interface BidOpportunityApi {
  loadState: () => Promise<BidOpportunityWorkspaceState>;
  saveEnterprise: (payload: { enterprise: EnterpriseProfile; qualifications: BidOpportunityQualification[]; performances: BidOpportunityPerformance[] }) => Promise<{ success: boolean; message?: string }>;
}

function getBidOpportunityApi(): BidOpportunityApi | undefined {
  const bridge = window.yibiao as unknown as { bidOpportunity?: BidOpportunityApi };
  return bridge?.bidOpportunity;
}

function createId(prefix: string) {
  const randomId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${randomId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 10)}`;
}

function EnterpriseProfilePage() {
  const { showToast } = useToast();
  const [enterpriseDraft, setEnterpriseDraft] = useState<EnterpriseProfile>({ companyName: '', industry: '', regions: [], strengths: '' });
  const [qualificationsDraft, setQualificationsDraft] = useState<BidOpportunityQualification[]>([]);
  const [performancesDraft, setPerformancesDraft] = useState<BidOpportunityPerformance[]>([]);
  const [enterpriseDirty, setEnterpriseDirty] = useState(false);
  const [savingEnterprise, setSavingEnterprise] = useState(false);

  useEffect(() => {
    trackPageView('bid-opportunity-enterprise');
  }, []);

  useEffect(() => {
    let canceled = false;
    const api = getBidOpportunityApi();
    if (!api) return;
    void api.loadState()
      .then((state) => {
        if (canceled || !state) return;
        setEnterpriseDraft(state.enterprise);
        setQualificationsDraft(state.qualifications);
        setPerformancesDraft(state.performances);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取企业画像失败', 'error');
      });
    return () => {
      canceled = true;
    };
  }, [showToast]);

  const handleSaveEnterprise = async () => {
    const api = getBidOpportunityApi();
    if (!api) return;
    setSavingEnterprise(true);
    try {
      const result = await api.saveEnterprise({
        enterprise: enterpriseDraft,
        qualifications: qualificationsDraft,
        performances: performancesDraft,
      });
      if (!result?.success) {
        showToast(result?.message || '企业画像保存失败', 'info');
        return;
      }
      setEnterpriseDirty(false);
      showToast('企业画像已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '企业画像保存失败', 'error');
    } finally {
      setSavingEnterprise(false);
    }
  };

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'enterprise',
      actions: [{ id: 'save', label: savingEnterprise ? '保存中...' : '保存画像', variant: 'primary', disabled: savingEnterprise, onClick: () => void handleSaveEnterprise() }],
    },
  ];

  return (
    <div className="bid-opportunity-page">
      <section className="bid-opportunity-command-bar">
        <div>
          <span className="section-kicker">企业画像</span>
          <strong>企业基本信息</strong>
          <p>维护公司名称、主营行业、优势区域、企业资质与历史业绩，用于投标机会匹配评分。</p>
        </div>
      </section>

      <section className="bid-opportunity-enterprise">
        <div className="bid-opportunity-panel">
          <div className="bid-opportunity-panel-head">
            <div>
              <span className="section-kicker">基本信息</span>
              <h3>企业画像</h3>
            </div>
          </div>
          <div className="enterprise-form-grid">
            <label>
              <span>企业名称</span>
              <input
                value={enterpriseDraft.companyName}
                onChange={(event) => { setEnterpriseDirty(true); setEnterpriseDraft((prev) => ({ ...prev, companyName: event.target.value })); }}
                placeholder="如：某某科技有限公司"
              />
            </label>
            <label>
              <span>主营行业</span>
              <input
                value={enterpriseDraft.industry}
                onChange={(event) => { setEnterpriseDirty(true); setEnterpriseDraft((prev) => ({ ...prev, industry: event.target.value })); }}
                placeholder="如：智慧城市、市政工程"
              />
            </label>
            <label>
              <span>优势区域（逗号分隔）</span>
              <input
                value={enterpriseDraft.regions.join('、')}
                onChange={(event) => {
                  setEnterpriseDirty(true);
                  setEnterpriseDraft((prev) => ({ ...prev, regions: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) }));
                }}
                placeholder="如：华东、华南"
              />
            </label>
            <label className="enterprise-form-span">
              <span>企业优势</span>
              <textarea
                value={enterpriseDraft.strengths}
                onChange={(event) => { setEnterpriseDirty(true); setEnterpriseDraft((prev) => ({ ...prev, strengths: event.target.value })); }}
                placeholder="如：具备多项一级资质、丰富的同行业交付经验"
                rows={3}
              />
            </label>
          </div>
        </div>

        <QualificationEditor
          items={qualificationsDraft}
          onChange={(items) => { setEnterpriseDirty(true); setQualificationsDraft(items); }}
        />
        <PerformanceEditor
          items={performancesDraft}
          onChange={(items) => { setEnterpriseDirty(true); setPerformancesDraft(items); }}
        />
      </section>

      <FloatingToolbar groups={toolbarGroups} label="企业画像工具条" />
    </div>
  );
}

function QualificationEditor({ items, onChange }: { items: BidOpportunityQualification[]; onChange: (items: BidOpportunityQualification[]) => void }) {
  return (
    <section className="bid-opportunity-panel bid-opportunity-qualifications">
      <div className="bid-opportunity-panel-head">
        <div>
          <span className="section-kicker">资质证书</span>
          <h3>企业资质</h3>
        </div>
        <button type="button" className="secondary-action" onClick={() => onChange([...items, { id: createId('qual'), name: '', level: '', certNo: '', validUntil: '', sortOrder: items.length }])}>新增资质</button>
      </div>
      {items.length ? items.map((item, index) => (
        <div className="qualification-row" key={item.id}>
          <input value={item.name} placeholder="证书名称" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))} />
          <input value={item.level} placeholder="等级" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, level: event.target.value } : row)))} />
          <input value={item.certNo} placeholder="证书编号" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, certNo: event.target.value } : row)))} />
          <input value={item.validUntil} placeholder="有效期" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, validUntil: event.target.value } : row)))} />
          <button type="button" className="danger-action" onClick={() => onChange(items.filter((_, i) => i !== index))}>删除</button>
        </div>
      )) : (
        <p className="bid-opportunity-empty">尚未填写资质证书。</p>
      )}
    </section>
  );
}

function PerformanceEditor({ items, onChange }: { items: BidOpportunityPerformance[]; onChange: (items: BidOpportunityPerformance[]) => void }) {
  return (
    <section className="bid-opportunity-panel bid-opportunity-performances">
      <div className="bid-opportunity-panel-head">
        <div>
          <span className="section-kicker">历史业绩</span>
          <h3>业绩案例</h3>
        </div>
        <button type="button" className="secondary-action" onClick={() => onChange([...items, { id: createId('perf'), projectName: '', industry: '', region: '', amount: '', completedAt: '', description: '', sortOrder: items.length }])}>新增业绩</button>
      </div>
      {items.length ? items.map((item, index) => (
        <div className="performance-row" key={item.id}>
          <input value={item.projectName} placeholder="项目名称" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, projectName: event.target.value } : row)))} />
          <input value={item.industry} placeholder="行业" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, industry: event.target.value } : row)))} />
          <input value={item.region} placeholder="地区" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, region: event.target.value } : row)))} />
          <input value={item.amount} placeholder="金额" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, amount: event.target.value } : row)))} />
          <input value={item.completedAt} placeholder="完成时间" onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, completedAt: event.target.value } : row)))} />
          <textarea value={item.description} placeholder="简述" rows={2} onChange={(event) => onChange(items.map((row, i) => (i === index ? { ...row, description: event.target.value } : row)))} />
          <button type="button" className="danger-action" onClick={() => onChange(items.filter((_, i) => i !== index))}>删除</button>
        </div>
      )) : (
        <p className="bid-opportunity-empty">尚未填写历史业绩。</p>
      )}
    </section>
  );
}

export default EnterpriseProfilePage;
