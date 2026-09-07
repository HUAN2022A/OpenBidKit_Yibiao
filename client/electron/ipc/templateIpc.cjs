const { ipcMain, dialog } = require('electron');
const { analyzeTemplateWord } = require('../services/templateWordAnalyzer.cjs');

function registerTemplateIpc({ templateStore, aiService, configStore }) {
  ipcMain.handle('templates:list', () => templateStore.listTemplates());
  ipcMain.handle('templates:get', (_event, templateId) => templateStore.getTemplate(templateId));
  ipcMain.handle('templates:create', (_event, config) => templateStore.createTemplate(config));
  ipcMain.handle('templates:update', (_event, templateId, config) => templateStore.updateTemplate(templateId, config));
  ipcMain.handle('templates:delete', (_event, templateId) => templateStore.deleteTemplate(templateId));

  // 分析用户选择的 Word 模板文档，抽取可直接预填导出格式表单的配置。
  ipcMain.handle('templates:analyze-word', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Word 模板',
      properties: ['openFile'],
      filters: [
        { name: 'Word 文档', extensions: ['doc', 'docx', 'wps'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) {
      throw new Error('已取消选择');
    }
    const filePath = result.filePaths[0];
    const offlineMode = configStore?.load?.()?.offline_mode === true;
    return analyzeTemplateWord({ aiService, filePath, offlineMode });
  });
}

module.exports = {
  registerTemplateIpc,
};
