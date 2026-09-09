// 投标机会渲染层状态类型。权威定义在 shared/types/ipc.ts，这里按 feature 约定再导出，
// 避免与共享桥接类型重复维护两份结构。

export type {
  BidOpportunity,
  BidOpportunityBackgroundTaskState,
  BidOpportunityCompetitorPrediction,
  BidOpportunityKeyDate,
  BidOpportunityParseStatus,
  BidOpportunityPerformance,
  BidOpportunityPricePrediction,
  BidOpportunityQualification,
  BidOpportunityRecommendation,
  BidOpportunityScoreDimension,
  BidOpportunityScoreResult,
  BidOpportunityStatus,
  BidOpportunityStructured,
  BidOpportunityWorkspacePatch,
  BidOpportunityWorkspaceState,
  EnterpriseProfile,
} from '../../shared/types/ipc';
