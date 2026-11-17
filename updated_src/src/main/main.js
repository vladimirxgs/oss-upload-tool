const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const config = require('./config');
const ossutil = require('./ossutil');
const history = require('./history');
const feishu = require('./feishu');
const feishuConfig = require('./feishu-config');
const updater = require('./updater');
const { SpeedTracker } = require('./speed');

// 解决部分机器（远程桌面 / 虚拟机 / 老旧显卡驱动）运行时出现的白屏：禁用 GPU 硬件加速。
app.disableHardwareAcceleration();
// 双保险：再禁用 GPU 合成，进一步规避 macOS 上 GPU 进程崩溃导致的窗口白屏。
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow;
let uploadBusy = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 600,
    minWidth: 560,
    minHeight: 440,
    title: 'OSS 上传工具',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// —— 云端更新检查：检测 GitHub 新版本并提醒下载 ——
let lastNotifiedVersion = null;

// 下载 + 替换 + 重启；下载进度通过 update:progress 推给渲染层。
async function doApplyUpdate(assetUrl) {
  try {
    await updater.applyUpdate(assetUrl, (received, total) => {
      const percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', { received, total, percent });
      }
    });
    // applyUpdate 内部会 app.quit()，正常走不到这里
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', null);
    }
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '更新失败',
      message: '更新失败，请稍后重试或手动下载',
      detail: err.message || String(err),
      buttons: ['知道了'],
    });
  }
}

async function runUpdateCheck({ silent = false } = {}) {
  try {
    const info = await updater.checkForUpdate();
    if (info.hasUpdate && info.latest !== lastNotifiedVersion) {
      lastNotifiedVersion = info.latest; // 同一版本只提醒一次，避免启动 + 6:00 重复弹
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${info.latest}（当前 ${info.current}）`,
        detail: info.body ? String(info.body).slice(0, 500) : '',
        buttons: ['更新', '稍后再说'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) await doApplyUpdate(info.assetUrl);
    }
    return { ok: true, ...info };
  } catch (err) {
    if (!silent) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新',
        message: '检查更新失败',
        detail: err.message || String(err),
        buttons: ['知道了'],
      });
    }
    return { ok: false, error: err.message || String(err), current: app.getVersion() };
  }
}

// 每天 6:00 检查一次更新（软件运行期间才会触发；启动时另有一次静默检查）。
function scheduleDailyUpdateCheck() {
  const HOUR = 6, MINUTE = 0;
  const nextDelay = () => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(HOUR, MINUTE, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  };
  const tick = () => {
    runUpdateCheck({ silent: true });
    setTimeout(tick, nextDelay());
  };
  setTimeout(tick, nextDelay());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 启动后延迟几秒静默检查一次（失败不打扰），再进入每天 6:00 的定时检查。
  setTimeout(() => runUpdateCheck({ silent: true }), 8000);
  scheduleDailyUpdateCheck();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 渲染进程 / GPU 进程崩溃时白屏兜底：自动重载窗口恢复界面（上传任务在主进程继续运行）。
let rendererCrashCount = 0;
let rendererCrashResetTimer = null;
app.on('render-process-gone', (_e, webContents, details) => {
  if (details.reason === 'clean-exit') return;
  rendererCrashCount += 1;
  if (rendererCrashResetTimer) clearTimeout(rendererCrashResetTimer);
  rendererCrashResetTimer = setTimeout(() => { rendererCrashCount = 0; }, 60000);
  if (rendererCrashCount > 3) return; // 连续崩溃，避免无限重载
  setTimeout(() => {
    const wc = (webContents && !webContents.isDestroyed())
      ? webContents
      : (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
    if (wc && !wc.isDestroyed()) wc.reload();
  }, 400);
});
app.on('child-process-gone', (_e, details) => {
  // GPU 进程崩溃：重载窗口，改走软件渲染
  if (details.type === 'GPU' && mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => mainWindow.reload(), 400);
  }
});

// UMI 数据按完整 session 上传并提交管线；其他类型仍为普通文件上传。
async function runUploads(paths, { type, date, prefix, bucket }) {
  const cfg = config.loadConfig();
  if (!config.isConfigured(cfg)) {
    return { ok: false, error: '请先点击右下角「配置」填写 endpoint / AccessKey' };
  }
  if (!type || !date) {
    return { ok: false, error: '请选择数据类型和日期' };
  }
  const bucketName = String(bucket || cfg.bucket || 'hw-upload').trim() || 'hw-upload';
  let effectivePrefix;
  try {
    effectivePrefix = ossutil.resolvePrefix(type, date, prefix, bucketName);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  const send = (text, replace = false) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:log', { text, replace });
    }
  };
  const sendProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:progress', msg);
    }
  };
  const speed = new SpeedTracker();
  const sendSpeed = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:speed', msg);
    }
  };
  const onBytes = (n) => sendSpeed(speed.addBytes(n));

  if (uploadBusy) return { ok: false, error: '已有上传任务正在运行，请等待完成' };
  if (!paths.length) return { ok: false, error: '没有选择上传文件或目录' };
  uploadBusy = true;
  try {
    speed.reset();
    sendSpeed(speed.snapshot());
    paths = [...new Set(paths.map((p) => path.resolve(p)))];
    const cfgPath = config.ossutilConfigPath();
    ossutil.resolveBinary();
    const planned = new Map(), seen = new Map();
    // 在写入 OSS 之前检查整批选择，防止选中部分 session/采集文件夹或日期不匹配。
    // normal / calibration / MK_UMI 按 session 发现；LG_Origin 按采集文件夹发现；
    // MK_MK / LG_MK / other 没有终端输出文件，跳过缺失检测，整目录直接上传。
    if (ossutil.needsDiscovery(type)) {
      for (const p of paths) {
        const datasets = ossutil.isLgOrigin(type)
          ? await ossutil.discoverLgOriginDatasets(p, { date, prefix: effectivePrefix, bucket: bucketName })
          : await ossutil.discoverDatasets(p, { type, date, prefix: effectivePrefix, bucket: bucketName });
        planned.set(p, datasets.filter((item) => {
          if (seen.has(item.rawUri)) {
            if (seen.get(item.rawUri) !== item.source) throw new Error('不同本地目录指向同一 OSS 数据集，请分开检查: ' + item.rawUri);
            return false;
          }
          seen.set(item.rawUri, item.source); return true;
        }));
      }
    }
    let uploaded = 0, submitted = 0, alreadyReady = 0;
    const failed = [], records = [];
    for (const p of paths) {
      send('== 上传: ' + p + ' ==');
      try {
        const result = await ossutil.upload(p, cfgPath, { type, date, prefix: effectivePrefix, bucket: bucketName, onLine: send, onProgress: sendProgress, onBytes, datasets: planned.get(p) });
        uploaded += result.datasets.length;
        submitted += result.datasets.filter((r) => r.status === 'submitted').length;
        alreadyReady += result.datasets.filter((r) => r.status === 'already-ready').length;
        failed.push(...(result.failed || []));
        for (const r of result.datasets) records.push({ kind: 'dataset', source: r.source, uri: r.rawUri, status: r.status, revision: r.revision, fileCount: r.fileCount });
        for (const f of (result.failed || [])) records.push({ kind: 'dataset', source: f.path, uri: null, status: 'failed', error: f.error });
      } catch (err) {
        send('✘ 失败: ' + (err.message || String(err)));
        failed.push({ path: p, error: err.message || String(err) });
        records.push({ kind: 'path', source: p, uri: null, status: 'failed', error: err.message || String(err) });
      }
    }
    const summaryPath = history.writeSummary({
      generatedAt: new Date().toISOString(),
      type, date,
      bucket: bucketName,
      prefix: effectivePrefix,
      managed: ossutil.isManaged(type),
      counts: { uploaded, submitted, alreadyReady, failed: failed.length },
      items: records,
    });
    send('已保存上传记录: ' + summaryPath);
    sendSpeed(speed.snapshot());
    return { ok: failed.length === 0, uploaded, submitted, alreadyReady, managed: ossutil.isManaged(type), lgOrigin: ossutil.isLgOrigin(type), failed, summaryPath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally { uploadBusy = false; }
}

ipcMain.handle('config:get', () => config.loadConfig());
ipcMain.handle('config:save', (_e, cfg) => config.saveConfig(cfg));

ipcMain.handle('app:info', () => {
  let binary = null;
  try {
    const b = ossutil.resolveBinary();
    binary = { path: b.path, fallback: b.fallback };
  } catch (err) {
    binary = { error: err.message };
  }
  return { platform: process.platform, arch: process.arch, binary };
});

// 手动检查更新（有新版会弹窗；无新版由渲染层提示“已是最新版本”）。
ipcMain.handle('update:check', () => runUpdateCheck({ silent: false }));

// 选择要上传的文件/目录（不立即上传，供渲染层决定是否先预览）
ipcMain.handle('upload:pick', async (_e, opts) => {
  const { type, bucket } = opts || {};
  const managed = ossutil.isManaged(type);
  const sessionToken = ossutil.isLgOrigin(type)
    ? 'LG_Origin 采集文件夹'
    : (ossutil.formatFor(bucket) === 'umi_v3' ? 'UMI_v3_xxx' : 'ISuit-V3_xxx');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择包含 ' + sessionToken + ' 的目录',
    buttonLabel: managed ? '下一步' : '上传',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true, paths: [] };
  return { canceled: false, paths: result.filePaths };
});

// 预览确认：发现所选目录下的数据集及其目标路径（不上传）
ipcMain.handle('upload:discover', async (_e, opts) => {
  const { type, date, prefix, bucket, paths } = opts || {};
  if (!ossutil.isManaged(type)) return { ok: false, error: '仅 normal / calibration 需要预览确认' };
  if (!config.isConfigured(config.loadConfig())) return { ok: false, error: '请先点击右下角「配置」填写信息' };
  try {
    const b = String(bucket || config.loadConfig().bucket || 'hw-upload').trim() || 'hw-upload';
    let datasets = [];
    for (const p of (Array.isArray(paths) ? paths : [])) {
      const found = await ossutil.discoverDatasets(p, { type, date, prefix, bucket: b });
      datasets = datasets.concat(found.map((d) => ({ source: d.source, datasetId: d.datasetId, relativePath: d.relativePath, deviceId: d.deviceId, deviceSn: d.deviceSn, uri: d.rawUri })));
    }
    if (!datasets.length) return { ok: false, error: '没有找到可上传的数据集' };
    return { ok: true, datasets };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// 上传入口（按钮选择 / 拖拽路径；确认后传入 prefix 与 paths）
ipcMain.handle('upload:paths', (_e, opts) => {
  const { type, date, prefix, bucket, paths } = opts || {};
  return runUploads(Array.isArray(paths) ? paths : [], { type, date, prefix, bucket });
});

// 打开本地上传记录目录
ipcMain.handle('history:open', async () => {
  const dir = history.historyDir();
  const err = await shell.openPath(dir);
  return { ok: !err, dir, error: err || '' };
});

// —— 项目负责人飞书群机器人 webhook 配置 + 确认消息 ——
ipcMain.handle('feishu:config:get', () => feishuConfig.loadConfig());
ipcMain.handle('feishu:config:save', (_e, cfg) => feishuConfig.saveConfig(cfg));

// 发送「其他」类型确认消息到飞书群（webhook 单向；负责人确认后由操作者在本地点「负责人已确认」）
ipcMain.handle('feishu:notify', async (_e, opts) => {
  const cfg = feishuConfig.loadConfig();
  if (!feishuConfig.isConfigured(cfg)) {
    return { ok: false, error: '请先配置负责人飞书群机器人（点右下角「飞书」）' };
  }
  const content = (opts && opts.content) || '【OSS 上传工具】用户请求使用「其他」类型上传数据，请负责人确认。';
  try {
    await feishu.sendWebhook(cfg, content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// 查看：逐级列出 prefix 下的子目录与文件
ipcMain.handle('list', async (_e, opts) => {
  const cfg = config.loadConfig();
  if (!config.isConfigured(cfg)) {
    return { ok: false, error: '请先点击右下角「配置」填写信息' };
  }
  const { prefix, bucket } = (typeof opts === 'string') ? { prefix: opts, bucket: '' } : (opts || {});
  try {
    const data = await ossutil.listDir(config.ossutilConfigPath(), prefix || '', bucket || cfg.bucket || 'hw-upload');
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
