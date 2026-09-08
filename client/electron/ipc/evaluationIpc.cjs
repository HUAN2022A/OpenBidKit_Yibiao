const { ipcMain } = require('electron');

function registerEvaluationIpc({ evaluationStore, taskService, checkResultExportService }) {
  ipcMain.handle('evaluation:load-state', () => evaluationStore.loadEvaluation());
  ipcMain.handle('evaluation:import-from-technical-plan', () => taskService.importEvaluationFromTechnicalPlan());
  ipcMain.handle('evaluation:save-ui-state', (_event, payload) => evaluationStore.updateEvaluation(payload));
  ipcMain.handle('evaluation:update-state', (_event, partial) => evaluationStore.updateEvaluationWithoutReload(partial));
  ipcMain.handle('evaluation:export-excel', (_event, request) => checkResultExportService.exportEvaluationExcel(request));
  ipcMain.handle('evaluation:clear', () => taskService.resetEvaluation());
  ipcMain.handle('tasks:start-evaluation-run', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startEvaluationRun(payload);
  });
}

module.exports = {
  registerEvaluationIpc,
};
