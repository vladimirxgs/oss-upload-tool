const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { BUCKET, TYPE_SUBDIR, destinationPrefix, toYymmdd, isManaged, isSessionType, isLgOrigin, needsDiscovery, resolvePrefix, formatFor } = require('../shared/upload-layout');
const pipeline = require('./pipeline-upload');

const BIN = 'ossutil';
const BIN_WIN = 'ossutil.exe';

// 根据当前平台/架构选择 ossutil 二进制所在子目录
function resolveDir() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') {
    return { dir: arch === 'arm64' ? 'mac-arm64' : 'mac-amd64', bin: BIN };
  }
  if (platform === 'win32') {
    return { dir: 'windows-amd64', bin: BIN_WIN };
  }
  if (platform === 'linux') {
    return { dir: arch === 'arm64' ? 'linux-arm64' : 'linux-amd64', bin: BIN };
  }
  throw new Error(`不支持的平台: ${platform}/${arch}`);
}

function baseDir() {
  const { app } = require('electron');
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ossutil')
    : path.join(__dirname, '..', '..', 'resources', 'ossutil');
}

// 返回 { path, fallback }；darwin/arm64 缺少 arm64 二进制时回退到 amd64（需 Rosetta 2）
function resolveBinary() {
  const { dir, bin } = resolveDir();
  const p = path.join(baseDir(), dir, bin);

  if (!fs.existsSync(p) && process.platform === 'darwin' && process.arch === 'arm64') {
    const fallback = path.join(baseDir(), 'mac-amd64', bin);
    if (fs.existsSync(fallback)) return { path: fallback, fallback: true };
  }
  if (!fs.existsSync(p)) {
    throw new Error(`未找到 ossutil 二进制（${process.platform}/${process.arch}）: ${p}`);
  }
  return { path: p, fallback: false };
}

// 执行 ossutil，返回 Promise<string>；onLine(text, replace) 逐段回传。
// replace=true 表示该段是回车 \r 的进度更新，渲染层应覆盖上一行而不是追加。
function run(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const { path: bin } = resolveBinary();
    const child = spawn(bin, args, { windowsHide: true });

    let out = '';
    let buf = '';
    const emit = (replace) => {
      const text = buf.trim();
      buf = '';
      if (!text) return;
      if (onLine) onLine(text, replace);
    };
    const handle = (chunk) => {
      const text = chunk.toString('utf8');
      out += text;
      for (const ch of text) {
        if (ch === '\n') emit(false);
        else if (ch === '\r') emit(true);
        else buf += ch;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      emit(false);
      if (code === 0) resolve(out);
      else reject(new Error(`ossutil 退出码 ${code}${out ? '\n' + out.trim() : ''}`));
    });
  });
}

// 每次复制检查错误报告；断点记录保存在应用数据目录，不能混入数据集。
function createStorage(cfgPath, { onLine, runCommand = run, stateRoot } = {}) {
  if (!stateRoot) stateRoot = path.join(require('electron').app.getPath('userData'), 'pipeline-uploads');
  fs.mkdirSync(stateRoot, { recursive: true });
  async function copyFile(source, target, digest, reportProgress = true) {
    const reports = fs.mkdtempSync(path.join(stateRoot, 'reports-'));
    const checkpoint = path.join(stateRoot, 'checkpoints', crypto.createHash('sha256').update(target + '\0' + digest).digest('hex'));
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    try {
      await runCommand(['cp', source, target, '--config-file', cfgPath, '-f', '--disable-ignore-error', '--output-dir=' + reports, '--checkpoint-dir=' + checkpoint], reportProgress ? { onLine } : {});
      if (fs.readdirSync(reports).some((name) => name.endsWith('.report') && fs.statSync(path.join(reports, name)).size > 0)) throw new Error('OSS 复制存在失败记录，尚未提交管线: ' + reports);
      fs.rmSync(reports, { recursive: true, force: true });
    } catch (error) {
      throw error;
    }
  }
  return {
    uploadFile: (source, uri, digest) => copyFile(source, uri, digest),
    async readObject(uri) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-read-'));
      const local = path.join(temporary, 'object');
      try {
        await runCommand(['cp', uri, local, '--config-file', cfgPath, '-f']);
        return fs.readFileSync(local);
      } catch (error) {
        if (/\bNoSuchKey\b/.test(error.message || '')) return null;
        throw error;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    },
    async listObjects(uri) {
      const output = await runCommand(['ls', uri, '--config-file', cfgPath]);
      const prefix = stripBucket(uri);
      const files = parseLsObjects(output, prefix);
      // 如果工具输出格式变化，不能把解析失败当成空目录。
      const objectUris = new Set(files.map((f) => uri + f.name));
      if (output.split('\n').some((line) => line.includes(uri) && !line.trim().endsWith('/') && !objectUris.has(line.slice(line.indexOf(uri)).trim()))) throw new Error('无法完整解析 OSS 文件列表，停止提交');
      return files;
    },
  };
}
async function upload(localPath, cfgPath, { type, date, prefix, bucket, onLine, datasets, onProgress, onBytes } = {}) {
  // LG_Origin：按采集文件夹逐个上传业务文件，生成 _LG_ORIGIN_MANIFEST.json + _LG_ORIGIN_READY.json 触发自动 OBS 发布。
  if (isLgOrigin(type)) {
    const planned = datasets || await pipeline.discoverLgOriginDatasets(localPath, { date, prefix, bucket });
    const storage = createStorage(cfgPath, { onLine });
    const results = [], failed = [];
    for (let i = 0; i < planned.length; i++) {
      const dataset = planned[i];
      if (onProgress) onProgress({ done: i, total: planned.length, label: dataset.datasetId });
      try {
        const result = await pipeline.uploadLgOriginDataset(dataset, storage, { onLine, onBytes });
        results.push({ ...result, source: dataset.source });
        if (onLine) onLine((result.status === 'submitted' ? '✔ 已提交自动发布: ' : '✔ 已提交过: ') + result.rawUri, false);
      } catch (error) {
        failed.push({ path: dataset.source, error: error.message || String(error) });
        if (onLine) onLine('✘ ' + dataset.source + ': ' + (error.message || String(error)), false);
      } finally {
        if (onProgress) onProgress({ done: i + 1, total: planned.length, label: dataset.datasetId });
      }
    }
    return { datasets: results, failed };
  }
  // 无终端输出文件的类型（MK_MK / LG_MK / other）：整目录 cp 到目标路径，不做数据集缺失检测。
  if (!isSessionType(type)) {
    const name = path.basename(localPath);
    const dest = resolvePrefix(type, date, prefix, bucket).replace(/\/+$/, '') + '/' + name;
    if (onProgress) onProgress({ done: 0, total: 1, label: name });
    try {
      await run(['cp', localPath, dest, '--config-file', cfgPath, '-f', '-r', '--disable-ignore-error'], { onLine });
      if (onLine) onLine('✔ 已上传: ' + dest + '/', false);
      return { datasets: [{ source: localPath, rawUri: dest + '/', status: 'success' }], failed: [] };
    } catch (error) {
      if (onLine) onLine('✘ ' + localPath + ': ' + (error.message || String(error)), false);
      return { datasets: [], failed: [{ path: localPath, error: error.message || String(error) }] };
    } finally {
      if (onProgress) onProgress({ done: 1, total: 1, label: name });
    }
  }
  // 含 ISuit-V3 / UMI_v3 终端输出的类型：按数据集逐个上传（平铺到 PRT_city_roomid/ 下）。
  const planned = datasets || await pipeline.discoverDatasets(localPath, { type, date, prefix, bucket });
  const results = [], failed = [];
  if (isManaged(type)) {
    // 托管类型（normal/calibration）：上传后生成清单并提交处理管线。
    const storage = createStorage(cfgPath, { onLine });
    for (let i = 0; i < planned.length; i++) {
      const dataset = planned[i];
      if (onProgress) onProgress({ done: i, total: planned.length, label: dataset.datasetId });
      try {
        const result = await pipeline.uploadDataset(dataset, storage, { onLine, onBytes });
        results.push({ ...result, source: dataset.source });
        if (onLine) onLine((result.status === 'submitted' ? '✔ 已提交处理: ' : '✔ 已提交过: ') + result.rawUri, false);
      } catch (error) {
        failed.push({ path: dataset.source, error: error.message || String(error) });
        if (onLine) onLine('✘ ' + dataset.source + ': ' + (error.message || String(error)), false);
      } finally {
        if (onProgress) onProgress({ done: i + 1, total: planned.length, label: dataset.datasetId });
      }
    }
  } else {
    // 非托管类型：每个数据集整目录 cp 到目标路径，不提交管线。
    for (let i = 0; i < planned.length; i++) {
      const dataset = planned[i];
      if (onProgress) onProgress({ done: i, total: planned.length, label: dataset.datasetId });
      const dest = dataset.rawUri.replace(/\/+$/, '');
      try {
        await run(['cp', dataset.source, dest, '--config-file', cfgPath, '-f', '-r', '--disable-ignore-error'], { onLine });
        results.push({ source: dataset.source, rawUri: dataset.rawUri, status: 'success' });
        if (onLine) onLine('✔ 已上传: ' + dataset.rawUri, false);
      } catch (error) {
        failed.push({ path: dataset.source, error: error.message || String(error) });
        if (onLine) onLine('✘ ' + dataset.source + ': ' + (error.message || String(error)), false);
      } finally {
        if (onProgress) onProgress({ done: i + 1, total: planned.length, label: dataset.datasetId });
      }
    }
  }
  return { datasets: results, failed };
}

function stripBucket(raw) {
  return raw.replace(/^oss:\/\/[^/]+\//, '');
}

// 解析 ossutil ls 长格式输出，返回文件数组（跳过表头/汇总行）
function parseLsObjects(output, prefix) {
  const files = [];
  for (const line of output.split('\n')) {
    const m = line.match(
      /^(.+?)\s+(\d+)\s+(Standard|IA|Archive|ColdArchive|DeepColdArchive)\s+([0-9A-Fa-f]{32}(?:-\d+)?)\s+(.+)$/
    );
    if (!m) continue;
    const rel = stripBucket(m[5].trim());
    let name = rel;
    if (prefix && rel.startsWith(prefix)) name = rel.slice(prefix.length);
    if (!name || name.endsWith('/')) continue;
    files.push({ name, size: Number(m[2]), lastModified: m[1].trim() });
  }
  return files;
}

// 解析 ossutil ls -d 输出，返回相对目录路径（不含 oss://bucket/ 前缀与末尾 /）
function parseLsDirs(output) {
  const dirs = [];
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t || !t.startsWith('oss://')) continue; // 只取目录行，跳过汇总/耗时等行
    const rel = stripBucket(t.split(/\s+/).pop()).replace(/\/+$/, '');
    if (rel) dirs.push(rel);
  }
  return dirs;
}

// 列出某个前缀下的子目录与文件（仿 OSS Browser 的逐级浏览）
async function listDir(cfgPath, prefix = '', bucket = '') {
  const b = String(bucket || '').trim() || BUCKET;
  const base = `oss://${b}/${prefix}`;
  const dirsOut = await run(['ls', base, '--config-file', cfgPath, '-d']);
  const filesOut = await run(['ls', base, '--config-file', cfgPath, '--limited-num=1000']);
  // ossutil ls 会递归列出所有对象，只保留当前层级（相对路径不含 /）的文件
  const files = parseLsObjects(filesOut, prefix).filter((f) => !f.name.includes('/'));
  return { prefix, bucket: b, dirs: parseLsDirs(dirsOut), files };
}

module.exports = {
  upload,
  createStorage,
  discoverDatasets: pipeline.discoverDatasets,
  discoverLgOriginDatasets: pipeline.discoverLgOriginDatasets,
  isManaged,
  isSessionType,
  isLgOrigin,
  needsDiscovery,
  formatFor,
  listDir,
  resolveBinary,
  destinationPrefix,
  resolvePrefix,
  toYymmdd,
  parseLsObjects,
  parseLsDirs,
  BUCKET,
  TYPE_SUBDIR,
};
