/**
 * 标书改进功能类型定义
 *
 * 独立的轻量级数据模型，不依赖 technical_plan_outline_nodes，
 * 便于快速迭代和后续回滚。
 */

export type BidImprovementRole = 'bid' | 'tender';

export type PolishGoal = 'professionalism' | 'conciseness' | 'compliance';

export type PolishStatus = 'idle' | 'running' | 'success' | 'error';

export type BridgeTarget = 'rejection-check' | 'evaluation';

/**
 * 简化的目录节点结构
 * 从文档解析后构建，仅包含展示和编辑必需字段
 */
export interface BidImprovementOutlineNode {
  id: string;
  title: string;
  level: number;
  content: string;
  children?: BidImprovementOutlineNode[];
}

/**
 * 文档内容
 */
export interface BidImprovementDocument {
  id: string;
  role: BidImprovementRole;
  fileName: string;
  sourcePath?: string;
  content: string;
  outline: BidImprovementOutlineNode[];
  parserLabel?: string;
  importedAt?: string;
}

/**
 * 润色请求
 */
export interface PolishRequest {
  nodeIds: string[];
  polishGoal: PolishGoal;
  tenderContext?: string;
}

/**
 * 润色结果（单个节点）
 */
export interface PolishResultItem {
  nodeId: string;
  originalContent: string;
  polishedContent: string;
}

/**
 * 润色历史记录
 */
export interface PolishHistoryItem {
  id: string;
  nodeId: string;
  originalContent: string;
  polishedContent: string;
  polishGoal: PolishGoal;
  accepted: boolean;
  createdAt: string;
}

/**
 * 工作区状态（Store 持久化）
 */
export interface BidImprovementWorkspaceState {
  documents: BidImprovementDocument[];
  activeDocumentId: string | null;
  activeNodeId?: string | null;
  selectedNodeIds?: string[];
}

/**
 * 润色任务状态（后台任务）
 */
export interface PolishTaskState {
  status: PolishStatus;
  progress: number;
  currentNodeId?: string;
  results: PolishResultItem[];
  error?: string;
}

/**
 * 桥接结果
 */
export interface BridgeResult {
  success: boolean;
  target: BridgeTarget;
  message?: string;
}
