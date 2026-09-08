import type { ReactNode } from 'react';
import type { SectionId } from '../../../shared/types/navigation';

interface StageEntry {
  id: SectionId;
  index: string;
  title: string;
  description: string;
  icon: ReactNode;
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const STAGES: StageEntry[] = [
  {
    id: 'prepare',
    index: '01',
    title: '准备',
    description: '机会、素材与知识资产',
    icon: (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
      </svg>
    ),
  },
  {
    id: 'generate',
    index: '02',
    title: '生成',
    description: '技术方案、商务标与可研',
    icon: (
      <svg {...svgProps}>
        <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
      </svg>
    ),
  },
  {
    id: 'review',
    index: '03',
    title: '审核',
    description: '查重、废标与AI评标',
    icon: (
      <svg {...svgProps}>
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'export',
    index: '04',
    title: '导出',
    description: '模板与格式配置',
    icon: (
      <svg {...svgProps}>
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M12 18v-6" />
        <path d="m9 15 3 3 3-3" />
      </svg>
    ),
  },
];

function WorkbenchHome({ onSectionChange }: { onSectionChange: (section: SectionId) => void }) {
  return (
    <div className="workbench-home">
      <header className="workbench-home__welcome">
        <span className="section-kicker">ForgeBid · 工作台</span>
        <h1 className="workbench-home__title">铸标</h1>
        <p className="workbench-home__subtitle">AI 标书工作台，从准备到导出全流程</p>
      </header>

      <section className="workbench-home__stages" aria-label="标书工作流阶段">
        {STAGES.map((stage) => (
          <button
            key={stage.id}
            type="button"
            className="workbench-stage-card"
            aria-label={`进入${stage.title}阶段`}
            onClick={() => onSectionChange(stage.id)}
          >
            <span className="workbench-stage-card__index">{stage.index}</span>
            <span className="workbench-stage-card__icon" aria-hidden="true">{stage.icon}</span>
            <span className="workbench-stage-card__title">{stage.title}</span>
            <span className="workbench-stage-card__desc">{stage.description}</span>
            <span className="workbench-stage-card__cta">
              进入
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}

export default WorkbenchHome;
