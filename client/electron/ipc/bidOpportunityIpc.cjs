const { ipcMain } = require('electron');

function registerBidOpportunityIpc({ bidOpportunityStore, taskService }) {
  ipcMain.handle('bid-opportunity:load-state', () => bidOpportunityStore.loadBidOpportunity());
  ipcMain.handle('bid-opportunity:read-announcement', (_event, opportunityId) => bidOpportunityStore.readAnnouncementMarkdown(opportunityId));
  ipcMain.handle('bid-opportunity:save-ui-state', (_event, payload) => bidOpportunityStore.updateBidOpportunity(payload));
  ipcMain.handle('bid-opportunity:import-announcement', () => taskService.importBidOpportunityAnnouncement());
  ipcMain.handle('bid-opportunity:import-from-technical-plan', () => taskService.importBidOpportunityFromTechnicalPlan());
  ipcMain.handle('bid-opportunity:import-from-url', (_event, url) => taskService.importBidOpportunityFromUrl(url));
  ipcMain.handle('bid-opportunity:create-announcement', (_event, payload) => taskService.createBidOpportunityAnnouncement(payload));
  ipcMain.handle('bid-opportunity:update-announcement', (_event, payload) => taskService.updateBidOpportunityAnnouncement(payload));
  ipcMain.handle('bid-opportunity:delete-announcement', (_event, payload) => taskService.deleteBidOpportunityAnnouncement(payload));
  ipcMain.handle('bid-opportunity:save-enterprise', (_event, payload) => taskService.saveBidOpportunityEnterprise(payload));
  ipcMain.handle('bid-opportunity:clear', () => taskService.resetBidOpportunity());
  ipcMain.handle('tasks:start-bid-opportunity-parse', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startBidOpportunityParse(payload);
  });
  ipcMain.handle('tasks:start-bid-opportunity-score', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startBidOpportunityScore(payload);
  });
  ipcMain.handle('tasks:start-bid-opportunity-price', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startBidOpportunityPrice(payload);
  });
}

module.exports = {
  registerBidOpportunityIpc,
};
