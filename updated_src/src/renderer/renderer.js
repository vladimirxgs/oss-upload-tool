const $ = (id) => document.getElementById(id);

// 兜底：渲染层出错时把错误显示到状态栏，而不是留下白屏。
window.addEventListener('error', (e) => {
  const status = document.getElementById('status');
  if (status) { status.textContent = '界面出错：' + (e.message || '未知错误'); status.style.color = '#d93025'; }
});
window.addEventListener('unhandledrejection', (e) => {
  const status = document.getElementById('status');
  if (status) { status.textContent = '异步出错：' + ((e.reason && e.reason.message) || String(e.reason || '未知错误')); status.style.color = '#d93025'; }
});

const el = {
  status: $('status'),
  btnUpload: $('btnUpload'),
  btnView: $('btnView'),
  btnConfig: $('btnConfig'),
  btnHistory: $('btnHistory'),
  btnFeishu: $('btnFeishu'),
  btnUpdate: $('btnUpdate'),
  result: $('result'),
  resultTitle: $('resultTitle'),
  resultBody: $('resultBody'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  speed: $('speed'),
  speedRate: $('speedRate'),
  speedBytes: $('speedBytes'),
  speedTime: $('speedTime'),
  configModal: $('configModal'),
  configForm: $('configForm'),
  cfgEndpoint: $('cfgEndpoint'),
  cfgAkid: $('cfgAkid'),
  cfgAksecret: $('cfgAksecret'),
  cfgCity: $('cfgCity'),
  cfgRoomId: $('cfgRoomId'),
  cfgBucket: $('cfgBucket'),
  cfgCancel: $('cfgCancel'),
  settingsModal: $('settingsModal'),
  settingsForm: $('settingsForm'),
  typeGroup: $('typeGroup'),
  cfgDate: $('cfgDate'),
  pathInput: $('pathInput'),
  pathPreview: $('pathPreview'),
  pathHint: $('pathHint'),
  uploadHint: $('uploadHint'),
  settingsError: $('settingsError'),
  settingsCancel: $('settingsCancel'),
  previewModal: $('previewModal'),
  previewPrefix: $('previewPrefix'),
  previewCount: $('previewCount'),
  previewList: $('previewList'),
  previewError: $('previewError'),
  previewCancel: $('previewCancel'),
  previewConfirm: $('previewConfirm'),
  typeInstruction: $('typeInstruction'),
  feishuStatus: $('feishuStatus'),
  feishuActions: $('feishuActions'),
  feishuSend: $('feishuSend'),
  feishuApprove: $('feishuApprove'),
  settingsSubmit: $('settingsSubmit'),
  feishuModal: $('feishuModal'),
  feishuForm: $('feishuForm'),
  fsWebhookUrl: $('fsWebhookUrl'),
  fsKeyword: $('fsKeyword'),
  fsSecret: $('fsSecret'),
  fsCancel: $('fsCancel'),
};

const { BUCKET, subdirFor, prefixFromSubdir, subdirOf, isManaged, isSessionType, isLgOrigin, prtDir, formatFor } = window.UploadLayout;
let siteConfig = { city: '', roomId: '', bucket: 'hw-upload' }; // 城市缩写 / 房间号 / 桶（用于拼接 PRT_city_roomid 与目标桶）

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(1) + ' ' + units[i];
}

function showResult(title) {
  el.result.classList.remove('hidden');
  el.resultTitle.textContent = title;
}

// —— 日志：进度行可覆盖；字符串拼接与 DOM 写入都放到 rAF 批量做，避免海量日志把渲染进程卡到白屏 ——
let logFinal = '';
let logCurrent = '';
let logPending = [];
let logRenderQueued = false;

function ensureLog() {
  if (el.resultBody.dataset.mode !== 'log') {
    el.resultBody.dataset.mode = 'log';
    el.resultBody.innerHTML = '<pre class="log"></pre>';
    logFinal = '';
    logCurrent = '';
    logPending = [];
    logRenderQueued = false;
  }
}
function renderLog() {
  logRenderQueued = false;
  if (logPending.length) {
    for (const t of logPending) logFinal += t + '\n';
    logPending = [];
    trimLog();
  }
  const pre = el.resultBody.querySelector('pre.log');
  if (!pre) return;
  pre.textContent = logFinal + logCurrent;
  pre.scrollTop = pre.scrollHeight;
}
function scheduleRenderLog() {
  if (logRenderQueued) return;
  logRenderQueued = true;
  requestAnimationFrame(renderLog);
}
// 超长时丢弃最前面的旧日志，防止字符串无限增长。
function trimLog() {
  if (logFinal.length <= 100000) return;
  const keepFrom = logFinal.indexOf('\n', logFinal.length - 80000);
  logFinal = '…（更早日志已省略）\n' + (keepFrom >= 0 ? logFinal.slice(keepFrom + 1) : '');
}
function logAppend(text) {
  ensureLog();
  if (logCurrent) { logPending.push(logCurrent); logCurrent = ''; }
  if (text) logPending.push(text);
  scheduleRenderLog();
}
function logReplace(text) {
  ensureLog();
  logCurrent = text || '';
  scheduleRenderLog();
}
function logLine(msg) {
  if (msg && typeof msg === 'object' && 'text' in msg) {
    msg.replace ? logReplace(msg.text) : logAppend(msg.text);
  } else {
    logAppend(String(msg ?? ''));
  }
}

// —— 实时网速（独立区块）——
function formatSpeed(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function resetSpeed() {
  el.speedRate.textContent = '—';
  el.speedBytes.textContent = '—';
  el.speedTime.textContent = '—';
}
function updateSpeed(msg) {
  if (!msg) return;
  el.speed.classList.remove('hidden');
  el.speedRate.textContent = formatSpeed(msg.bytesPerSec);
  el.speedBytes.textContent = formatSize(msg.totalBytes) || '—';
  el.speedTime.textContent = formatDuration(msg.elapsedMs);
}

// —— 进度条 ——
function showProgress() { el.progress.classList.remove('hidden'); el.speed.classList.remove('hidden'); resetSpeed(); }
function hideProgress() { el.progress.classList.add('hidden'); el.speed.classList.add('hidden'); }
function updateProgress(msg) {
  if (!msg) return;
  el.progress.classList.remove('hidden');
  if (msg.indeterminate) {
    el.progress.classList.add('indeterminate');
    el.progressFill.style.width = '';
    el.progressText.textContent = msg.label || '上传中…';
  } else {
    el.progress.classList.remove('indeterminate');
    const total = Math.max(1, Number(msg.total) || 0);
    const done = Math.max(0, Number(msg.done) || 0);
    el.progressFill.style.width = Math.min(100, Math.round(done / total * 100)) + '%';
    el.progressText.textContent = `${msg.label || '上传中'}（${done}/${total}）`;
  }
}

function handleUploadResult(res) {
  hideProgress();
  if (res && res.canceled) { logLine('已取消'); return; }
  if (!res) { logLine('✘ 未收到上传结果'); return; }
  if (res.error) { logLine('✘ ' + res.error); return; }
  const failures = res.failed || [];
  logLine('');
  if (res.managed) logLine(`上传结束：新提交管线 ${res.submitted || 0} 条，已提交过 ${res.alreadyReady || 0} 条，失败 ${failures.length} 条。后续转换和质检请查看 pipeline 看板。`);
  else if (res.lgOrigin) logLine(`上传结束：已提交自动发布 ${res.submitted || 0} 份，已提交过 ${res.alreadyReady || 0} 份，失败 ${failures.length} 份。服务端每 60 秒扫描一次，稍后在看板查看 OBS 发布状态。`);
  else logLine(`上传结束：成功 ${res.uploaded || 0} 项，失败 ${failures.length} 项。`);
  for (const item of failures) logLine('✘ ' + item.path + ': ' + item.error);
}

// 选定路径后：托管类型先预览确认，普通类型直接上传
async function proceedWithPaths(type, date, prefix, paths) {
  if (isManaged(type)) {
    const disc = await window.api.discoverUpload({ type, date, prefix, bucket: siteConfig.bucket, paths });
    if (!disc.ok) { logLine('✘ ' + (disc.error || '预览失败')); return; }
    openPreview(type, date, prefix, paths, disc.datasets);
  } else {
    showProgress(); updateProgress({ indeterminate: true, label: '上传中…' });
    try {
      const result = await window.api.uploadPaths({ type, date, prefix, bucket: siteConfig.bucket, paths });
      handleUploadResult(result);
    } catch (error) { hideProgress(); logLine('✘ ' + (error.message || String(error))); }
  }
}

// —— 上传预览（托管类型，确认目标路径）——
let previewState = null;
function renderPreviewList() {
  const st = previewState;
  let prefix = '';
  try { prefix = prefixFromSubdir(st ? st.date : '', el.previewPrefix.value.trim(), siteConfig.bucket); }
  catch (error) { prefix = ''; }
  const datasets = st ? st.datasets : [];
  el.previewList.innerHTML = datasets.map((d) => {
    const uri = prefix + '/' + (d.relativePath || d.datasetId) + '/';
    const device = (d.deviceId || d.deviceSn)
      ? `<div class="preview-device">device_ID：${escapeHtml(d.deviceId || '—')} · device_SN：${escapeHtml(d.deviceSn || '—')}</div>`
      : '';
    return `<div class="preview-item">
      <div class="preview-name" title="${escapeHtml(d.source)}">${escapeHtml(d.datasetId)}</div>
      ${device}
      <div class="preview-uri">${escapeHtml(uri)}</div>
    </div>`;
  }).join('');
  el.previewCount.textContent = `共 ${datasets.length} 个数据集，将上传到：`;
}
function openPreview(type, date, prefix, paths, datasets) {
  previewState = { type, date, paths, datasets };
  el.previewPrefix.value = subdirOf(prefix, date, siteConfig.bucket);
  el.previewError.classList.add('hidden');
  renderPreviewList();
  el.previewModal.classList.remove('hidden');
}
function closePreview() { previewState = null; el.previewModal.classList.add('hidden'); }
el.previewPrefix.addEventListener('input', renderPreviewList);
el.previewCancel.addEventListener('click', closePreview);
el.previewModal.addEventListener('click', (e) => { if (e.target === el.previewModal) closePreview(); });
el.previewConfirm.addEventListener('click', async () => {
  if (!previewState) return;
  const subdir = el.previewPrefix.value.trim();
  const err = validatePrefix(previewState.date, subdir);
  if (err) { el.previewError.textContent = err; el.previewError.classList.remove('hidden'); return; }
  const prefix = prefixFromSubdir(previewState.date, subdir, siteConfig.bucket);
  const st = previewState;
  closePreview();
  showProgress(); updateProgress({ indeterminate: true, label: '上传中…' });
  try {
    const result = await window.api.uploadPaths({ type: st.type, date: st.date, prefix, bucket: siteConfig.bucket, paths: st.paths });
    handleUploadResult(result);
  } catch (error) { hideProgress(); logLine('✘ ' + (error.message || String(error))); }
});

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function refreshStatus() {
  const cfg = await window.api.getConfig();
  siteConfig = { city: cfg.city || '', roomId: cfg.roomId || '', bucket: cfg.bucket || 'hw-upload' };
  const info = await window.api.appInfo();
  const configured = cfg && cfg.endpoint && cfg.accessKeyID && cfg.accessKeySecret;
  let text = configured ? `已配置 · ${cfg.endpoint}` : '未配置 — 请点右下角「配置」';
  if (info.binary && info.binary.fallback) text += ' · 回退 amd64 二进制';
  el.status.textContent = text;
}

// —— 上传设置（数据类型 + 日期 + 目标路径，必选）——
let pendingUpload = null;

function currentSettings() {
  const checked = el.typeGroup.querySelector('input[name="dtype"]:checked');
  return { type: checked ? checked.value : '', date: el.cfgDate.value.trim() };
}
function updatePathInput() {
  const { type, date } = currentSettings();
  if (!type || !date) return;
  try { el.pathInput.value = subdirFor(type, date); }
  catch (error) { el.pathInput.value = ''; }
  updatePathPreview(date);
}
function updatePathPreview(date) {
  const subdir = el.pathInput.value.trim();
  if (!date || !subdir) { el.pathPreview.textContent = ''; el.pathPreview.classList.remove('err'); return; }
  try {
    el.pathPreview.textContent = '目标路径：' + buildPrefix(date, subdir) + '/';
    el.pathPreview.classList.remove('err');
  } catch (error) {
    el.pathPreview.textContent = '⚠ ' + (error.message || '目标路径无效');
    el.pathPreview.classList.add('err');
  }
}
// 「其他」类型：路径框泛光 + 提示文字
function updateTypeHint() {
  const { type } = currentSettings();
  const isOther = type === 'other';
  el.pathInput.classList.toggle('glow', isOther);
  el.pathHint.classList.toggle('hidden', !isOther);
}
// 拼出最终前缀：oss://{bucket}/raw_data/raw_data_YYMMDD/{子目录}/PRT_{城市}_room{房间号}
// LG_Origin 的房间目录来自本地目录结构，不额外拼 PRT 段。
function buildPrefix(date, subdir) {
  const { type } = currentSettings();
  const full = (type === 'LG_Origin')
    ? subdir
    : subdir + '/' + prtDir(siteConfig.city, siteConfig.roomId);
  return prefixFromSubdir(date, full, siteConfig.bucket);
}
// 校验目标路径（预览弹窗用，子目录已含 PRT 段，不做二次拼接）
function validatePrefix(date, value) {
  try { prefixFromSubdir(date, value, siteConfig.bucket); return ''; }
  catch (error) { return error.message || '目标路径无效'; }
}

// —— 动态类型说明 + 「其他」飞书审批确认 ——
const TYPE_INSTRUCTION = {
  normal: 'normal / calibration：选择完整数据集或房间目录，上传完成后自动提交管线。请在采集结束后上传。',
  calibration: 'normal / calibration：选择完整数据集或房间目录，上传完成后自动提交管线。请在采集结束后上传。',
  MK_MK: '放梅卡非空桌面数据',
  MK_UMI: '放与MK_MK匹配的UMI数据',
  LG_MK: '放梅卡曼德空桌面数据',
  LG_Origin: 'LG_Origin：选择采集文件夹或其上级目录，上传后自动生成清单并触发 OBS 发布。',
  other: '请与项目负责人联系',
};
const HIGHLIGHT_TYPES = new Set(['MK_MK', 'MK_UMI', 'LG_MK', 'LG_Origin', 'other']);

// 上传目录提示：含终端输出的类型要选 session 目录；无终端输出的类型选普通数据目录即可。
// session 目录名（ISuit-V3_xxx / UMI_v3_xxx）随所选桶变化。
function updateInstruction(type) {
  el.typeInstruction.textContent = TYPE_INSTRUCTION[type] || TYPE_INSTRUCTION.normal;
  el.typeInstruction.classList.toggle('highlight', HIGHLIGHT_TYPES.has(type));
  const tok = formatFor(siteConfig.bucket) === 'umi_v3' ? 'UMI_v3_xxx' : 'ISuit-V3_xxx';
  if (isLgOrigin(type)) {
    el.uploadHint.textContent = '选择包含 PRT_城市_room编号R次数_日期时间 采集文件夹的目录即可';
  } else if (isSessionType(type)) {
    el.uploadHint.textContent = `选择包含 ${tok} 的目录即可`;
  } else {
    el.uploadHint.textContent = `选择要上传的数据目录即可（此类型无需 ${tok} 结构）`;
  }
}

const feishuState = { sent: false, approved: false };

function stopFeishuFlow() {
  feishuState.sent = false;
  feishuState.approved = false;
  el.feishuStatus.classList.add('hidden');
  el.feishuStatus.classList.remove('ok', 'err');
  el.feishuActions.classList.add('hidden');
  el.settingsSubmit.disabled = false;
}

function startFeishuFlow() {
  el.settingsSubmit.disabled = true;
  el.feishuStatus.classList.remove('hidden', 'ok', 'err');
  el.feishuStatus.textContent = '请点击「发送确认请求」把确认信息发到飞书群';
  el.feishuActions.classList.remove('hidden');
  el.feishuSend.classList.remove('hidden');
  el.feishuApprove.classList.add('hidden');
  el.feishuSend.disabled = false;
  el.feishuApprove.disabled = false;
}

async function sendFeishuRequest() {
  const { date } = currentSettings();
  const content = '【OSS 上传工具】用户请求使用「其他」类型上传数据' + (date ? '，采集日期 ' + date : '') + '，请负责人确认。';
  el.feishuSend.disabled = true;
  el.feishuStatus.classList.remove('ok', 'err');
  el.feishuStatus.textContent = '正在发送确认请求…';
  const res = await window.api.feishuNotify({ content });
  if (!res.ok) {
    el.feishuSend.disabled = false;
    el.feishuStatus.textContent = '✘ ' + (res.error || '发送确认失败');
    el.feishuStatus.classList.add('err');
    return;
  }
  feishuState.sent = true;
  el.feishuStatus.textContent = '✓ 已发送到飞书群，等待负责人确认后点「负责人已确认」';
  el.feishuStatus.classList.add('ok');
  el.feishuSend.classList.add('hidden');
  el.feishuApprove.classList.remove('hidden');
}

function approveFeishu() {
  feishuState.approved = true;
  el.feishuStatus.textContent = '✓ 负责人已确认，可以上传';
  el.feishuStatus.classList.remove('err');
  el.feishuStatus.classList.add('ok');
  el.feishuApprove.disabled = true;
  el.settingsSubmit.disabled = false;
}

el.feishuSend.addEventListener('click', sendFeishuRequest);
el.feishuApprove.addEventListener('click', approveFeishu);

function handleOtherFlow(type) {
  if (type === 'other') startFeishuFlow();
  else stopFeishuFlow();
}
function openSettings() {
  el.settingsError.classList.add('hidden');
  stopFeishuFlow();
  if (!el.cfgDate.value) el.cfgDate.value = todayStr();
  if (!el.pathInput.value) updatePathInput();
  const { type, date } = currentSettings();
  updateInstruction(type);
  updateTypeHint();
  updatePathPreview(date);
  if (type === 'other') handleOtherFlow(type);
  el.settingsModal.classList.remove('hidden');
}
function closeSettings() { el.settingsModal.classList.add('hidden'); }

el.btnUpload.addEventListener('click', () => { pendingUpload = 'button'; openSettings(); });
el.settingsCancel.addEventListener('click', () => { pendingUpload = null; closeSettings(); });
el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) { pendingUpload = null; closeSettings(); } });
el.typeGroup.addEventListener('change', () => {
  updatePathInput();
  updateInstruction(currentSettings().type);
  updateTypeHint();
  handleOtherFlow(currentSettings().type);
});
el.cfgDate.addEventListener('input', updatePathInput);
el.pathInput.addEventListener('input', () => updatePathPreview(currentSettings().date));

el.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { type, date } = currentSettings();
  if (!type || !date) {
    el.settingsError.textContent = '请选择数据类型和日期';
    el.settingsError.classList.remove('hidden');
    return;
  }
  if (type === 'other' && !feishuState.approved) {
    el.settingsError.textContent = '请先发送确认请求并等待负责人确认（点「负责人已确认」后即可上传）';
    el.settingsError.classList.remove('hidden');
    return;
  }
  const subdir = el.pathInput.value.trim();
  let prefix = '';
  try { prefix = buildPrefix(date, subdir); }
  catch (error) {
    el.settingsError.textContent = error.message || '目标路径无效';
    el.settingsError.classList.remove('hidden');
    return;
  }
  const action = pendingUpload;
  pendingUpload = null;
  closeSettings();

  showResult('上传');
  if (action === 'button') {
    logLine('选择要上传的文件或目录…');
    const picked = await window.api.pickUpload({ type, bucket: siteConfig.bucket });
    if (picked.canceled || !picked.paths.length) { logLine('已取消'); return; }
    await proceedWithPaths(type, date, prefix, picked.paths);
  } else if (action && action.type === 'drop') {
    logLine(`拖入 ${action.paths.length} 项`);
    await proceedWithPaths(type, date, prefix, action.paths);
  }
});

// —— 查看（仿 OSS Browser 逐级浏览）——
let viewPrefix = '';

function crumbSegments(prefix) {
  const segs = [{ label: siteConfig.bucket || BUCKET, prefix: '' }];
  if (prefix) {
    let acc = '';
    for (const part of prefix.replace(/\/+$/, '').split('/')) {
      if (!part) continue;
      acc += part + '/';
      segs.push({ label: part, prefix: acc });
    }
  }
  return segs;
}

function renderBrowser(data) {
  viewPrefix = data.prefix || '';
  el.resultBody.dataset.mode = 'browser';

  const segs = crumbSegments(viewPrefix);
  const crumbs = segs.map((s, i) =>
    `<span class="crumb${i === segs.length - 1 ? ' current' : ''}" data-prefix="${escapeHtml(s.prefix)}">${escapeHtml(s.label)}</span>`
  ).join('<span class="crumb-sep">/</span>');

  const dirs = data.dirs || [];
  const files = data.files || [];

  const foldersHtml = dirs.map((d) => {
    const name = d.split('/').filter(Boolean).pop() || d;
    return `<div class="folder" data-prefix="${escapeHtml(d + '/')}" title="${escapeHtml(d)}">
      <svg viewBox="0 0 24 24" class="folder-icon"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
      <span>${escapeHtml(name)}</span>
    </div>`;
  }).join('');

  const filesHtml = files.map((f) => `
    <tr>
      <td class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</td>
      <td class="size">${formatSize(f.size)}</td>
      <td class="time">${escapeHtml((f.lastModified || '').slice(0, 19))}</td>
    </tr>`).join('');

  const count = dirs.length + files.length;
  el.resultTitle.textContent = `桶内文件 · ${count} 项`;

  el.resultBody.innerHTML = `
    <div class="browser">
      <div class="browser-toolbar">
        <button class="tool-btn" id="btnUp" title="上一级"${viewPrefix ? '' : ' disabled'}>← 上级</button>
        <div class="breadcrumb">${crumbs}</div>
        <button class="tool-btn" id="btnRefresh" title="刷新">↻ 刷新</button>
      </div>
      <div class="browser-list">
        ${foldersHtml ? `<div class="folders">${foldersHtml}</div>` : ''}
        ${filesHtml ? `<div class="table-wrap"><table><thead><tr><th>文件名</th><th>大小</th><th>修改时间</th></tr></thead><tbody>${filesHtml}</tbody></table></div>` : ''}
        ${count === 0 ? '<div class="empty">（空目录）</div>' : ''}
      </div>
    </div>`;
}

async function loadDir(prefix) {
  el.resultBody.dataset.mode = 'loading';
  el.resultBody.innerHTML = '<div class="loading">加载中…</div>';
  const res = await window.api.list({ prefix, bucket: siteConfig.bucket });
  if (!res.ok) {
    el.resultBody.dataset.mode = '';
    el.resultBody.innerHTML = `<div class="error">${escapeHtml(res.error || '查看失败')}</div>`;
    return;
  }
  renderBrowser(res);
}

el.btnView.addEventListener('click', () => { showResult('查看'); loadDir(''); });

el.resultBody.addEventListener('click', (e) => {
  const crumb = e.target.closest('.crumb');
  if (crumb) { loadDir(crumb.dataset.prefix || ''); return; }
  const folder = e.target.closest('.folder');
  if (folder) { loadDir(folder.dataset.prefix || ''); return; }
  if (e.target.closest('#btnUp')) { loadDir(viewPrefix.replace(/[^/]+\/$/, '')); return; }
  if (e.target.closest('#btnRefresh')) { loadDir(viewPrefix); }
});

// —— 拖拽上传 ——
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [];
  for (const f of e.dataTransfer.files) if (f.path) paths.push(f.path);
  if (!paths.length) return;
  pendingUpload = { type: 'drop', paths };
  openSettings();
});

// —— 配置 ——
function openConfig() {
  window.api.getConfig().then((cfg) => {
    el.cfgEndpoint.value = cfg.endpoint || '';
    el.cfgAkid.value = cfg.accessKeyID || '';
    el.cfgAksecret.value = cfg.accessKeySecret || '';
    el.cfgCity.value = cfg.city || '';
    el.cfgRoomId.value = cfg.roomId || '';
    el.cfgBucket.value = cfg.bucket || 'hw-upload';
    el.configModal.classList.remove('hidden');
    el.cfgEndpoint.focus();
  });
}
function closeConfig() { el.configModal.classList.add('hidden'); }

el.btnConfig.addEventListener('click', openConfig);
el.cfgCancel.addEventListener('click', closeConfig);
el.configModal.addEventListener('click', (e) => { if (e.target === el.configModal) closeConfig(); });

el.configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await window.api.saveConfig({
    endpoint: el.cfgEndpoint.value.trim(),
    accessKeyID: el.cfgAkid.value.trim(),
    accessKeySecret: el.cfgAksecret.value.trim(),
    city: el.cfgCity.value.trim(),
    roomId: el.cfgRoomId.value.trim(),
    bucket: el.cfgBucket.value.trim() || 'hw-upload',
  });
  closeConfig();
  refreshStatus();
});

// —— 项目负责人飞书配置 ——
function openFeishuConfig() {
  window.api.feishuGetConfig().then((cfg) => {
    el.fsWebhookUrl.value = cfg.webhookUrl || '';
    el.fsKeyword.value = cfg.keyword || '';
    el.fsSecret.value = cfg.secret || '';
    el.feishuModal.classList.remove('hidden');
  });
}
function closeFeishuConfig() { el.feishuModal.classList.add('hidden'); }

el.btnFeishu.addEventListener('click', openFeishuConfig);
el.fsCancel.addEventListener('click', closeFeishuConfig);
el.feishuModal.addEventListener('click', (e) => { if (e.target === el.feishuModal) closeFeishuConfig(); });

el.feishuForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await window.api.feishuSaveConfig({
    webhookUrl: el.fsWebhookUrl.value.trim(),
    keyword: el.fsKeyword.value.trim(),
    secret: el.fsSecret.value.trim(),
  });
  closeFeishuConfig();
});

window.api.onLog((msg) => logLine(msg));
window.api.onProgress((msg) => updateProgress(msg));
window.api.onSpeed((msg) => updateSpeed(msg));
window.api.onUpdateProgress((msg) => {
  if (!msg) { refreshStatus(); return; } // null 表示更新结束/失败，恢复状态栏
  el.status.style.color = '';
  el.status.textContent = msg.percent != null
    ? `正在下载更新… ${msg.percent}%`
    : '正在下载更新…';
});

el.btnHistory.addEventListener('click', () => window.api.openHistory());
el.btnUpdate.addEventListener('click', async () => {
  el.status.textContent = '正在检查更新…';
  const r = await window.api.checkUpdate();
  if (r && r.ok && !r.hasUpdate) {
    el.status.textContent = '已是最新版本 v' + r.current;
  } else if (r && r.ok && r.hasUpdate) {
    el.status.textContent = '发现新版本 v' + r.latest;
  } else {
    await refreshStatus(); // 失败/取消时恢复配置状态
  }
});

refreshStatus();
