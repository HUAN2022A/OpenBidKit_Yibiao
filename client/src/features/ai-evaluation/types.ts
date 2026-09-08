// AI 评标渲染层状态类型，镜像「AI评标实现方案.md」第四节 Store 状态结构。

export type EvaluationStep = 'documents' | 'items' | 'results';

/** Store 持久化的 UI 标签页（仅区分「导入」与「结果」两个落点）。 */
export type EvaluationActiveTab = 'documents' | 'results';

export type EvaluationDocumentRole = 'technical-plan';

export type EvaluationDocumentSource = 'technical-plan';

export type EvaluationScoringItemsStatus = 'idle' | 'success' | 'error';

export type EvaluationRunStatus = 'idle' | 'running' | 'success' | 'error';

export type EvaluationBackgroundTaskType = 'evaluation-run';

export type EvaluationBackgroundTaskStatus = 'running' | 'success' | 'error';

export interface EvaluationDocumentContent {
  id: string;
  role: EvaluationDocumentRole;
  fileName: string;
  content: string;
  source: EvaluationDocumentSource;
  importedAt: string;
}

export interface EvaluationScoringItemsState {
  status: EvaluationScoringItemsStatus;
  content: string;
  source: EvaluationDocumentSource;
  updatedAt?: string;
  error?: string;
}

export interface EvaluationRunOptions {
  judgeCount: number;
}

export interface EvaluationScoreItem {
  id: string;
  name: string;
  maxScore: number;
  score: number;
  criteria: string;
  evidence: string;
  deductionReason: string;
  suggestion: string;
}

export interface EvaluationResultState {
  status: EvaluationRunStatus;
  inputSignature?: string;
  totalScore: number;
  totalMaxScore: number;
  scoreRate: number;
  overallComment: string;
  items: EvaluationScoreItem[];
  activeItemId?: string;
  progressMessage?: string;
  error?: string;
  updatedAt?: string;
}

export interface EvaluationBackgroundTaskState {
  task_id: string;
  type: EvaluationBackgroundTaskType;
  status: EvaluationBackgroundTaskStatus;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
}

export interface EvaluationWorkspaceState {
  technicalPlanDocument: EvaluationDocumentContent | null;
  scoringItems: EvaluationScoringItemsState;
  runOptions: EvaluationRunOptions;
  evaluationResult: EvaluationResultState;
  evaluationTask?: EvaluationBackgroundTaskState;
  activeTab: EvaluationActiveTab;
}

/** updateState 的 partial 语义：结果字段允许局部覆盖（activeItemId / 进度 / 状态等）。 */
export type EvaluationWorkspacePatch = Omit<Partial<EvaluationWorkspaceState>, 'evaluationResult'> & {
  evaluationResult?: Partial<EvaluationResultState>;
};
