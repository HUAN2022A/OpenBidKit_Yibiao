// 生产模式端到端校验：走真实的 configStore.load()/save() 路径，
// 验证 production_mode 能否穿过 normalizeConfig 白名单。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../electron/services/configStore.cjs');

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label} — 期望 ${expected}，实际 ${actual}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prodmode-'));
const app = { getPath: () => tmp };
const store = createConfigStore(app);

console.log('临时 userData:', tmp);
console.log(`配置文件: ${store.getConfigFilePath()}\n`);

// 场景 1：配置文件里显式写入 production_mode: true，load() 必须原样返回
fs.writeFileSync(store.getConfigFilePath(), JSON.stringify({ production_mode: true }), 'utf-8');
const loaded = store.load();
check('load() 返回 production_mode', loaded.production_mode, true);

// 场景 2：load() 回写磁盘后，键不能被抹掉
const onDiskAfterLoad = JSON.parse(fs.readFileSync(store.getConfigFilePath(), 'utf-8'));
check('load() 回写后磁盘仍保留该键', onDiskAfterLoad.production_mode, true);

// 场景 3：save() 之后仍然保留
store.save({ production_mode: true });
const onDiskAfterSave = JSON.parse(fs.readFileSync(store.getConfigFilePath(), 'utf-8'));
check('save() 后磁盘仍保留该键', onDiskAfterSave.production_mode, true);

// 场景 4：缺省时回落为 false（开发模式），且不能是 undefined
fs.writeFileSync(store.getConfigFilePath(), JSON.stringify({}), 'utf-8');
const fresh = store.load();
check('缺省时回落为 false', fresh.production_mode, false);

// 场景 5：非布尔值归一化为布尔
fs.writeFileSync(store.getConfigFilePath(), JSON.stringify({ production_mode: 'yes' }), 'utf-8');
check('字符串值被归一化为布尔', store.load().production_mode, true);

// 场景 6：关闭后能被正确读回
fs.writeFileSync(store.getConfigFilePath(), JSON.stringify({ production_mode: false }), 'utf-8');
check('关闭后读回 false', store.load().production_mode, false);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
