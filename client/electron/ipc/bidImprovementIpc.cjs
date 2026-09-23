const { ipcMain } = require('electron');

function registerBidImprovementIpc({ bidImprovementService }) {
  // 文档管理
  ipcMain.handle('bid-improvement:import-document', (_event, filePath, role) => bidImprovementService.importDocument(filePath, role));
  ipcMain.handle('bid-improvement:get-document', (_event, documentId) => bidImprovementService.getDocument(documentId));
  ipcMain.handle('bid-improvement:get-all-documents', () => bidImprovementService.getAllDocuments());
  ipcMain.handle('bid-improvement:delete-document', (_event, documentId) => bidImprovementService.deleteDocument(documentId));

  // 目录与内容
  ipcMain.handle('bid-improvement:get-outline-nodes', (_event, documentId) => bidImprovementService.getOutlineNodes(documentId));
  ipcMain.handle('bid-improvement:update-node-content', (_event, nodeId, content) => bidImprovementService.updateNodeContent(nodeId, content));

  // 润色历史
  ipcMain.handle('bid-improvement:get-polish-history', (_event, nodeId) => bidImprovementService.getPolishHistory(nodeId));
  ipcMain.handle('bid-improvement:save-polish-result', (_event, result) => bidImprovementService.savePolishResult(result));

  // 工作区状态
  ipcMain.handle('bid-improvement:get-workspace-state', () => bidImprovementService.getWorkspaceState());
  ipcMain.handle('bid-improvement:update-workspace-state', (_event, patch) => bidImprovementService.updateWorkspaceState(patch));
  ipcMain.handle('bid-improvement:clear', () => bidImprovementService.clear());

  // 桥接功能
  ipcMain.handle('bid-improvement:bridge-to-rejection-check', (_event, documentId) => bidImprovementService.bridgeToRejectionCheck(documentId));
  ipcMain.handle('bid-improvement:bridge-to-evaluation', (_event, documentId) => bidImprovementService.bridgeToEvaluation(documentId));

  // 导出
  ipcMain.handle('bid-improvement:export-document', (_event, documentId) => bidImprovementService.exportDocument(documentId));
}

module.exports = {
  registerBidImprovementIpc,
};
