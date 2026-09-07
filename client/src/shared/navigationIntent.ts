/**
 * 跨页面导航意图：纯 Renderer 共享模块，不依赖任何 feature。
 * 用于「图片知识库 → 文档知识库」的定位跳转：来源页先记录目标文档 ID，
 * 目标页挂载时消费一次并自动选中/展开对应文档。
 */

let pendingKnowledgeDocumentId: string | null = null;

/** 记录待定位的知识文档 ID（覆盖之前未消费的值） */
export function setPendingKnowledgeDocument(documentId: string) {
  pendingKnowledgeDocumentId = documentId;
}

/** 取出并清空待定位的知识文档 ID；无待定位时返回 null */
export function consumePendingKnowledgeDocument(): string | null {
  const documentId = pendingKnowledgeDocumentId;
  pendingKnowledgeDocumentId = null;
  return documentId;
}
