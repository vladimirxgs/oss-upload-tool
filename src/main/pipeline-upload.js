const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { toYymmdd, isManaged, resolvePrefix, formatFor } = require('../shared/upload-layout');
const MARKERS = new Set(['manifest.json', '_READY', '_SUCCESS.json']);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isExcluded = (relative) => relative.split('/').includes('_pipeline') || MARKERS.has(path.posix.basename(relative));
// LG_Origin 业务文件排除：控制文件、系统辅助文件、管线标记。
const LG_CONTROLS = new Set(['_LG_ORIGIN_MANIFEST.json', '_LG_ORIGIN_READY.json']);
const LG_SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const isLgExcluded = (relative) => {
  const base = path.posix.basename(relative);
  return relative.split('/').includes('_pipeline')
    || MARKERS.has(base)
    || LG_CONTROLS.has(base)
    || LG_SYSTEM_FILES.has(base)
    || base.startsWith('._');
};
// LG_Origin 采集文件夹命名：PRT_<城市>_room<编号>R<次数>_YYYY-MM-DD-HHMMSS
const LG_ORIGIN_NAME_RE = /^PRT_[A-Za-z0-9]+_room[A-Za-z0-9]+R\d+_\d{4}-\d{2}-\d{2}-\d{6}$/;
const LG_ORIGIN_MANIFEST = '_LG_ORIGIN_MANIFEST.json';
const LG_ORIGIN_READY = '_LG_ORIGIN_READY.json';
function safePart(name) {
  if (!name || name === '.' || name === '..' || /[\\/\r\n?#\0]/.test(name)) throw new Error('目录名不安全: ' + name);
  return name;
}
async function regularStat(filename) {
  const stat = await fsp.lstat(filename);
  if (stat.isSymbolicLink()) throw new Error('数据集不支持符号链接: ' + filename);
  return stat;
}
// 数据集格式定义：不同桶对应不同 session 命名与结构。
const FORMAT = {
  isuit: {
    desc: 'datacollect_conf.yaml 和采集切片',
    conf: 'datacollect_conf.yaml',
    sessionDate(name) {
      const m = name.match(/^.+_(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}$/);
      return m ? m[1] : null;
    },
    validate(dir, name, entries) {
      if (!entries.some((e) => e.name === 'datacollect_conf.yaml' && e.isFile())) throw new Error('数据集缺少 datacollect_conf.yaml: ' + dir);
      if (!entries.some((e) => e.isDirectory() && e.name.startsWith(name + '_') && /^\d+$/.test(e.name.slice(name.length + 1)))) throw new Error('数据集缺少数字编号的采集切片: ' + dir);
    },
  },
  umi_v3: {
    desc: 'metadata/conf.yaml 和 head/left hand/right hand 采集目录',
    conf: 'metadata/conf.yaml',
    sessionDate(name) {
      const m = name.match(/^UMI_v3_(\d{8})_(\d{6})$/);
      return m ? m[1].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
    },
    validate(dir, name, entries) {
      if (!fs.existsSync(path.join(dir, 'metadata', 'conf.yaml'))) throw new Error('数据集缺少 metadata/conf.yaml: ' + dir);
      for (const sub of ['head', 'left hand', 'right hand']) {
        if (!entries.some((e) => e.isDirectory() && e.name === sub)) throw new Error('数据集缺少采集目录 ' + sub + ': ' + dir);
      }
    },
  },
};
// 读取数据集配置文件里的 device_ID / device_SN（缺失时返回空串）
function readDeviceInfo(dir, conf) {
  try {
    const text = fs.readFileSync(path.join(dir, conf), 'utf8');
    const id = (text.match(/^device_ID:\s*(.+?)\s*$/m) || [])[1] || '';
    const sn = (text.match(/^device_SN:\s*(.+?)\s*$/m) || [])[1] || '';
    return { deviceId: id, deviceSn: sn };
  } catch {
    return { deviceId: '', deviceSn: '' };
  }
}

async function discoverDatasets(selectedPath, { type, date, prefix: customPrefix, bucket }) {
  const selected = path.resolve(selectedPath);
  if (!(await regularStat(selected)).isDirectory()) throw new Error('需要完整数据集目录，不能只上传单个文件');
  const fmt = FORMAT[formatFor(bucket)];
  const prefix = resolvePrefix(type, date, customPrefix, bucket);
  const datasets = [];
  async function visit(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const name = path.basename(dir);
    const captureDate = fmt.sessionDate(name);
    if (captureDate) {
      fmt.validate(dir, name, entries);
      if (toYymmdd(captureDate) !== toYymmdd(date)) throw new Error(`采集日期不一致: ${name}，请选择 ${captureDate}`);
      const dev = readDeviceInfo(dir, fmt.conf);
      datasets.push({ source: dir, datasetId: name, captureDate, type, relativePath: name, deviceId: dev.deviceId, deviceSn: dev.deviceSn, rawUri: prefix + '/' + name + '/', conf: fmt.conf });
      return;
    }
    for (const e of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (e.name === '_pipeline' || e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) throw new Error('上传目录不支持符号链接: ' + path.join(dir, e.name));
      if (e.isDirectory()) await visit(path.join(dir, e.name));
    }
  }
  await visit(selected);
  if (!datasets.length) throw new Error('没有找到完整数据集。请选择带 ' + fmt.desc + ' 的 session，或包含它们的目录');
  return datasets;
}
async function hashFile(filename) {
  const before = await regularStat(filename);
  if (!before.isFile()) throw new Error('不是普通文件: ' + filename);
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  const after = await regularStat(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('文件正在变化，请结束采集后重试: ' + filename);
  return { size: after.size, sha256: digest.digest('hex') };
}
async function snapshot(source, exclude = isExcluded) {
  const files = [];
  async function visit(dir, parts = []) {
    for (const name of (await fsp.readdir(dir)).sort()) {
      safePart(name);
      const rel = [...parts, name].join('/');
      if (exclude(rel)) continue;
      const file = path.join(dir, name), stat = await regularStat(file);
      if (stat.isDirectory()) await visit(file, [...parts, name]);
      else if (stat.isFile()) files.push({ path: rel, ...await hashFile(file) });
      else throw new Error('不支持的文件类型: ' + file);
    }
  }
  await visit(source);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.length) throw new Error('数据集为空: ' + source);
  return files;
}
function makeManifest(dataset, files) {
  const identity = { dataset_id: dataset.datasetId, capture_date: dataset.captureDate, dataset_type: dataset.type, files };
  return { schema_version: 1, ...identity, revision: 'raw-' + sha(JSON.stringify(identity)).slice(0, 32), created_at: new Date().toISOString() };
}
function sameContent(a, b) {
  return a.schema_version === 1 && a.dataset_id === b.dataset_id && a.capture_date === b.capture_date && a.dataset_type === b.dataset_type && JSON.stringify(a.files) === JSON.stringify(b.files);
}
async function remoteCommit(storage, rawUri) {
  const readyBytes = await storage.readObject(rawUri + '_READY');
  if (readyBytes === null) return null;
  const manifestBytes = await storage.readObject(rawUri + 'manifest.json');
  if (manifestBytes === null) throw new Error('远端已有 _READY 但缺少清单，拒绝覆盖: ' + rawUri);
  const ready = JSON.parse(readyBytes.toString('utf8')), manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (ready.schema_version !== 1 || ready.revision !== manifest.revision || ready.manifest_sha256 !== sha(manifestBytes)) throw new Error('远端完成标记与清单不一致，拒绝覆盖: ' + rawUri);
  return { ready, manifest };
}
async function verifyInventory(storage, rawUri, files) {
  const remote = (await storage.listObjects(rawUri)).filter((f) => !isExcluded(f.name));
  const byName = new Map(remote.map((f) => [f.name, f.size]));
  const localNames = new Set(files.map((f) => f.path));
  const extra = remote.filter((f) => !localNames.has(f.name)).map((f) => f.name);
  const missing = files.filter((f) => !byName.has(f.path)).map((f) => f.path);
  const sizeMismatch = files.filter((f) => byName.has(f.path) && byName.get(f.path) !== f.size).map((f) => f.path);
  if (extra.length || missing.length || sizeMismatch.length) {
    const parts = [];
    if (extra.length) parts.push(`远端多了 ${extra.length} 个对象（如 ${extra.slice(0, 3).join('、')}）`);
    if (missing.length) parts.push(`远端缺 ${missing.length} 个文件（如 ${missing.slice(0, 3).join('、')}）`);
    if (sizeMismatch.length) parts.push(`大小不一致 ${sizeMismatch.length} 个（如 ${sizeMismatch.slice(0, 3).join('、')}）`);
    throw new Error('远端文件与本地清单不一致，未发送完成标记：' + parts.join('；') + '。请检查后重试: ' + rawUri);
  }
}
async function uploadDataset(dataset, storage, { onLine = () => {}, onBytes = () => {}, temporaryRoot = os.tmpdir() } = {}) {
  const log = (text) => onLine(text, false);
  log('生成数据清单: ' + dataset.source);
  const files = await snapshot(dataset.source), manifest = makeManifest(dataset, files);
  const cfg = await fsp.readFile(path.join(dataset.source, dataset.conf || 'datacollect_conf.yaml'), 'utf8');
  if (/^record_location:\s*["']?Default["']?\s*(?:#.*)?$/m.test(cfg)) log('提示：采集位置为 Default，后续交付需要正确的房间元数据；上传程序不会自动猜测房间。');
  const existing = await remoteCommit(storage, dataset.rawUri);
  if (existing) {
    if (!sameContent(existing.manifest, manifest)) throw new Error('同一路径已提交过不同内容，不能覆盖正在处理或已完成的数据集: ' + dataset.rawUri);
    await verifyInventory(storage, dataset.rawUri, files);
    log('已提交过相同数据，保留原版本，不重复创建任务: ' + dataset.rawUri);
    return { status: 'already-ready', rawUri: dataset.rawUri, revision: existing.manifest.revision, fileCount: files.length };
  }
  const temporary = await fsp.mkdtemp(path.join(temporaryRoot, 'pipeline-upload-'));
  try {
    onBytes(0); // 重置瞬时计时，避免数据集准备/复核等开销压低首个文件的瞬时速度
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      log(`[${i + 1}/${files.length}] 上传 ${file.path}`);
      await storage.uploadFile(path.join(dataset.source, ...file.path.split('/')), dataset.rawUri + file.path, file.sha256);
      onBytes(file.size);
    }
    log('复核本地文件和 OSS 文件列表…');
    if (JSON.stringify(await snapshot(dataset.source)) !== JSON.stringify(files)) throw new Error('上传过程中数据集发生变化，未发送完成标记；请结束采集后重试');
    await verifyInventory(storage, dataset.rawUri, files);
    const concurrent = await remoteCommit(storage, dataset.rawUri);
    if (concurrent) {
      if (!sameContent(concurrent.manifest, manifest)) throw new Error('其他上传进程已提交不同版本，请勿同时上传同一数据集');
      return { status: 'already-ready', rawUri: dataset.rawUri, revision: concurrent.manifest.revision, fileCount: files.length };
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const manifestPath = path.join(temporary, 'manifest.json');
    await fsp.writeFile(manifestPath, manifestBytes);
    await storage.uploadFile(manifestPath, dataset.rawUri + 'manifest.json', sha(manifestBytes));
    const remoteManifest = await storage.readObject(dataset.rawUri + 'manifest.json');
    if (!remoteManifest || !remoteManifest.equals(manifestBytes)) throw new Error('远端清单校验失败，未发送完成标记');
    const marker = { schema_version: 1, revision: manifest.revision, manifest_sha256: sha(manifestBytes) };
    const readyPath = path.join(temporary, '_READY');
    const readyBytes = Buffer.from(JSON.stringify(marker, null, 2) + '\n');
    await fsp.writeFile(readyPath, readyBytes);
    log('所有文件上传成功，提交数据集到处理管线…');
    await storage.uploadFile(readyPath, dataset.rawUri + '_READY', sha(readyBytes));
    const confirmed = await remoteCommit(storage, dataset.rawUri);
    if (!confirmed || confirmed.ready.manifest_sha256 !== marker.manifest_sha256) throw new Error('完成标记确认失败，请重试以确认提交状态');
    return { status: 'submitted', rawUri: dataset.rawUri, revision: manifest.revision, fileCount: files.length };
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}
// —— LG_Origin 自动直传：发现采集文件夹、生成清单与完成标记 ——
// 递归发现最末级采集文件夹，每个作为一份独立数据。
async function discoverLgOriginDatasets(selectedPath, { date, prefix: customPrefix, bucket }) {
  const selected = path.resolve(selectedPath);
  if (!(await regularStat(selected)).isDirectory()) throw new Error('LG_Origin 需要选择目录');
  const prefix = resolvePrefix('LG_Origin', date, customPrefix, bucket);
  const datasets = [];
  const push = (source, name, rel) => {
    const m = name.match(/(\d{4}-\d{2}-\d{2})-\d{6}$/);
    if (m && toYymmdd(m[1]) !== toYymmdd(date)) throw new Error(`采集日期不一致: ${name}，请选择 ${m[1]}`);
    datasets.push({ source, datasetId: name, captureDate: m ? m[1] : '', type: 'LG_Origin', relativePath: rel, deviceId: '', deviceSn: '', rawUri: prefix + '/' + rel + '/', conf: null });
  };
  // 所选目录本身即采集文件夹
  if (LG_ORIGIN_NAME_RE.test(path.basename(selected))) {
    push(selected, path.basename(selected), path.basename(selected));
    return datasets;
  }
  async function walk(dir, parts) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (e.name === '_pipeline' || e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) throw new Error('上传目录不支持符号链接: ' + path.join(dir, e.name));
      if (!e.isDirectory()) continue;
      const childParts = [...parts, e.name];
      if (LG_ORIGIN_NAME_RE.test(e.name)) {
        push(path.join(dir, e.name), e.name, childParts.join('/'));
      } else {
        await walk(path.join(dir, e.name), childParts);
      }
    }
  }
  await walk(selected, []);
  if (!datasets.length) throw new Error('没有找到 LG_Origin 采集文件夹（PRT_城市_room编号R次数_YYYY-MM-DD-HHMMSS）');
  return datasets;
}
function makeLgManifestBytes(datasetId, files) {
  return Buffer.from(JSON.stringify({ schema_version: 1, dataset_type: 'LG_Origin', dataset_id: datasetId, files }, null, 2) + '\n', 'utf8');
}
function makeLgReadyBytes(manifestSha) {
  return Buffer.from(JSON.stringify({ schema_version: 1, manifest_sha256: manifestSha }, null, 2) + '\n', 'utf8');
}
async function remoteLgCommit(storage, rawUri) {
  const readyBytes = await storage.readObject(rawUri + LG_ORIGIN_READY);
  if (readyBytes === null) return null;
  const manifestBytes = await storage.readObject(rawUri + LG_ORIGIN_MANIFEST);
  if (manifestBytes === null) throw new Error('远端已有 _LG_ORIGIN_READY.json 但缺少清单，拒绝覆盖: ' + rawUri);
  const ready = JSON.parse(readyBytes.toString('utf8'));
  if (ready.schema_version !== 1 || ready.manifest_sha256 !== sha(manifestBytes)) throw new Error('远端完成标记与清单不一致，拒绝覆盖: ' + rawUri);
  return { ready, manifestBytes, manifestSha: sha(manifestBytes) };
}
async function verifyInventoryLg(storage, rawUri, files) {
  const remote = (await storage.listObjects(rawUri)).filter((f) => !isLgExcluded(f.name));
  const byName = new Map(remote.map((f) => [f.name, f.size]));
  const localNames = new Set(files.map((f) => f.path));
  const extra = remote.filter((f) => !localNames.has(f.name)).map((f) => f.name);
  const missing = files.filter((f) => !byName.has(f.path)).map((f) => f.path);
  const sizeMismatch = files.filter((f) => byName.has(f.path) && byName.get(f.path) !== f.size).map((f) => f.path);
  if (extra.length || missing.length || sizeMismatch.length) {
    const parts = [];
    if (extra.length) parts.push(`远端多了 ${extra.length} 个对象（如 ${extra.slice(0, 3).join('、')}）`);
    if (missing.length) parts.push(`远端缺 ${missing.length} 个文件（如 ${missing.slice(0, 3).join('、')}）`);
    if (sizeMismatch.length) parts.push(`大小不一致 ${sizeMismatch.length} 个（如 ${sizeMismatch.slice(0, 3).join('、')}）`);
    throw new Error('远端文件与本地清单不一致，未发送完成标记：' + parts.join('；') + '。请检查后重试: ' + rawUri);
  }
}
async function uploadLgOriginDataset(dataset, storage, { onLine = () => {}, onBytes = () => {}, temporaryRoot = os.tmpdir() } = {}) {
  const log = (text) => onLine(text, false);
  const rawUri = dataset.rawUri;
  log('生成业务文件清单: ' + dataset.source);
  const files = await snapshot(dataset.source, isLgExcluded);
  if (files.length > 50000) throw new Error('业务文件数超过上限 50000: ' + files.length);
  const manifestBytes = makeLgManifestBytes(dataset.datasetId, files);
  if (manifestBytes.length > 8 * 1024 * 1024) throw new Error('清单文件超过 8 MiB 上限: ' + manifestBytes.length);
  const manifestSha = sha(manifestBytes);

  const existing = await remoteLgCommit(storage, rawUri);
  if (existing) {
    if (!existing.manifestBytes.equals(manifestBytes)) throw new Error('同一路径已有不同内容的 LG_Origin 清单，拒绝覆盖: ' + rawUri);
    await verifyInventoryLg(storage, rawUri, files);
    log('已提交过相同数据，保留原版本，不重复创建任务: ' + rawUri);
    return { status: 'already-ready', rawUri, fileCount: files.length };
  }

  const temporary = await fsp.mkdtemp(path.join(temporaryRoot, 'lg-origin-'));
  try {
    onBytes(0); // 重置瞬时计时
    log('上传业务文件（' + files.length + ' 个）…');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      log(`[${i + 1}/${files.length}] 上传 ${file.path}`);
      await storage.uploadFile(path.join(dataset.source, ...file.path.split('/')), rawUri + file.path, file.sha256);
      onBytes(file.size);
    }
    log('核对 OSS 对象与本地清单…');
    if (JSON.stringify(await snapshot(dataset.source, isLgExcluded)) !== JSON.stringify(files)) throw new Error('上传过程中数据集发生变化，未发送完成标记；请结束采集后重试');
    await verifyInventoryLg(storage, rawUri, files);

    const manifestPath = path.join(temporary, LG_ORIGIN_MANIFEST);
    await fsp.writeFile(manifestPath, manifestBytes);
    log('提交文件清单 ' + LG_ORIGIN_MANIFEST + '…');
    await storage.uploadFile(manifestPath, rawUri + LG_ORIGIN_MANIFEST, manifestSha);
    const remoteManifest = await storage.readObject(rawUri + LG_ORIGIN_MANIFEST);
    if (!remoteManifest || !remoteManifest.equals(manifestBytes)) throw new Error('远端清单校验失败，未发送完成标记');

    const readyBytes = makeLgReadyBytes(manifestSha);
    const readyPath = path.join(temporary, LG_ORIGIN_READY);
    await fsp.writeFile(readyPath, readyBytes);
    log('提交完成标记 ' + LG_ORIGIN_READY + '…');
    await storage.uploadFile(readyPath, rawUri + LG_ORIGIN_READY, sha(readyBytes));
    const confirmed = await remoteLgCommit(storage, rawUri);
    if (!confirmed || confirmed.manifestSha !== manifestSha) throw new Error('完成标记确认失败，请重试以确认提交状态');
    return { status: 'submitted', rawUri, fileCount: files.length };
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { isManaged, discoverDatasets, snapshot, makeManifest, uploadDataset, isExcluded, discoverLgOriginDatasets, uploadLgOriginDataset };
