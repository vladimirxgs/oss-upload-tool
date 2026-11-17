const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

// GitHub 仓库：https://github.com/vladimirxgs/oss-upload-tool
const GITHUB_REPO = 'vladimirxgs/oss-upload-tool';
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

// 把版本字符串拆成数字数组，兼容 'v1.9.0' / '1.9.0' / '1.10.2' 等。
function parseVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[.-]/).map((seg) => {
    const m = String(seg).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  });
}
// 返回 a>b 为正数、a===b 为 0、a<b 为负数。
function compareVersions(a, b) {
  const av = parseVersion(a), bv = parseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] || 0, y = bv[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 从 release 的 tag_name / name 里提取语义化版本号（优先 tag，回退 name）。
// 兼容 tag 被误填成日期等情况：只要 tag 或 name 里写了 vX.Y.Z 就能正确识别。
function extractVersion(release) {
  const tag = String(release.tag_name || '');
  const name = String(release.name || '');
  const re = /v?(\d+\.\d+(?:\.\d+)?)/i;
  const m = tag.match(re) || name.match(re);
  return m ? m[1] : tag.replace(/^v/i, '');
}

// 走 Electron net（自动使用系统代理），请求 JSON。
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const request = net.request({ url, redirect: 'follow' });
    const timer = setTimeout(() => { request.abort(); done(reject, new Error('检查更新超时')); }, 15000);
    request.setHeader('User-Agent', 'oss-upload-tool-updater');
    request.setHeader('Accept', 'application/vnd.github.v3+json');
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        done(reject, new Error(`GitHub API 返回 ${response.statusCode}`));
        return;
      }
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => { try { done(resolve, JSON.parse(data)); } catch (e) { done(reject, e); } });
    });
    request.on('error', (err) => done(reject, err));
    request.end();
  });
}

// 从 release 的 assets 里挑出当前平台/架构的便携包。
function pickAsset(release) {
  const platform = process.platform, arch = process.arch;
  const assets = release.assets || [];
  let pred;
  if (platform === 'win32') pred = (n) => n.includes('Windows-x64-portable.zip');
  else if (platform === 'darwin') {
    pred = arch === 'arm64'
      ? (n) => n.includes('arm64-mac.zip')
      : (n) => n.endsWith('-mac.zip') && !n.includes('arm64');
  } else if (platform === 'linux') {
    pred = (n) => n.includes(arch === 'arm64' ? 'Linux-arm64-portable.tar.gz' : 'Linux-x64-portable.tar.gz');
  }
  if (!pred) return null;
  const found = assets.find((a) => pred(a.name));
  return found ? found.browser_download_url : null;
}

// 查询最新 release，返回 { hasUpdate, current, latest, name, body, htmlUrl, assetUrl }。
async function checkForUpdate() {
  const current = app.getVersion();
  const release = await httpGetJson(API_URL);
  const latest = extractVersion(release);
  const assetUrl = pickAsset(release);
  return {
    hasUpdate: compareVersions(latest, current) > 0,
    current,
    latest,
    name: release.name || release.tag_name || latest,
    body: release.body || '',
    htmlUrl: release.html_url || RELEASES_URL,
    assetUrl,
  };
}

// 下载文件到本地（流式写盘），onProgress(received, total)。
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = net.request({ url, redirect: 'follow' });
    request.setHeader('User-Agent', 'oss-upload-tool-updater');
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        file.destroy();
        reject(new Error(`下载返回 ${response.statusCode}`));
        return;
      }
      const total = parseInt(String(response.headers['content-length'] || '0'), 10) || 0;
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        file.write(chunk);
        if (onProgress) onProgress(received, total);
      });
      response.on('end', () => { file.end(() => resolve()); });
      response.on('error', (e) => { file.destroy(); reject(e); });
    });
    request.on('error', (e) => { file.destroy(); reject(e); });
    request.end();
  });
}

// 解压当前平台的包到 newDir。
function extract(archivePath, newDir, platform) {
  if (platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${newDir}'`,
    ], { stdio: 'ignore' });
  } else if (platform === 'darwin') {
    execFileSync('ditto', ['-x', '-k', archivePath, newDir], { stdio: 'ignore' });
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', newDir], { stdio: 'ignore' });
  }
}

// 安装根目录：Windows/Linux 是 exe 所在目录；mac 是 .app 的上一级（zip 解压目录）。
function getInstallRoot(platform) {
  if (platform === 'darwin') {
    const macosDir = path.dirname(process.execPath);   // Contents/MacOS
    const appDir = path.dirname(path.dirname(macosDir)); // .app
    return path.dirname(appDir);
  }
  return path.dirname(process.execPath);
}

// 解压目录里实际要替换的内容根：
// Windows/Linux zip/tar.gz 里是一个普通目录；mac zip 里是一个 .app。
function locateExtractedTarget(newDir, platform) {
  if (platform === 'darwin') {
    for (const name of fs.readdirSync(newDir)) {
      if (name.endsWith('.app') && fs.statSync(path.join(newDir, name)).isDirectory()) {
        return { kind: 'app', path: path.join(newDir, name), name };
      }
    }
    throw new Error('更新包内未找到 .app');
  }
  const entries = fs.readdirSync(newDir);
  if (entries.length === 1 && fs.statSync(path.join(newDir, entries[0])).isDirectory()) {
    return { kind: 'dir', path: path.join(newDir, entries[0]), name: entries[0] };
  }
  return { kind: 'dir', path: newDir, name: null };
}

// 生成替换脚本，返回脚本路径。
function writeUpdateScript(tmp, newDir, installRoot, exe, platform) {
  const target = locateExtractedTarget(newDir, platform);
  if (platform === 'win32') {
    // PowerShell 脚本（UTF-8 BOM，中文路径稳妥）
    const ps = [
      'Start-Sleep -Seconds 2',
      `robocopy "${target.path}" "${installRoot}" /E /IS /IT /R:5 /W:2 /NFL /NDL /NJH /NJS | Out-Null`,
      `Start-Process -FilePath "${exe}"`,
    ].join('\n');
    const scriptPath = path.join(tmp, 'update.ps1');
    fs.writeFileSync(scriptPath, '﻿' + ps, 'utf8');
    return scriptPath;
  }
  let body;
  if (platform === 'darwin') {
    body = [
      '#!/bin/sh', 'sleep 2',
      `rm -rf "${path.join(installRoot, target.name)}"`,
      `cp -R "${target.path}" "${installRoot}/"`,
      `open "${path.join(installRoot, target.name)}"`,
    ].join('\n');
  } else {
    body = [
      '#!/bin/sh', 'sleep 2',
      `cp -Rf "${target.path}/." "${installRoot}/"`,
      `"${exe}" &`,
    ].join('\n');
  }
  const scriptPath = path.join(tmp, 'update.sh');
  fs.writeFileSync(scriptPath, body, 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// 启动替换脚本（独立进程），随后退出主程序。
function launchUpdater(scriptPath, platform) {
  if (platform === 'win32') {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('sh', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  }
  app.quit();
}

// 下载 → 解压 → 生成替换脚本 → 启动脚本并退出。
async function applyUpdate(assetUrl, onProgress) {
  const platform = process.platform;
  if (!assetUrl) throw new Error('该版本没有当前平台的更新包');
  const installRoot = getInstallRoot(platform);
  const exe = process.execPath;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-update-'));
  try {
    const archivePath = path.join(tmp, platform === 'linux' ? 'update.tar.gz' : 'update.zip');
    await downloadFile(assetUrl, archivePath, onProgress);
    const newDir = path.join(tmp, 'new');
    fs.mkdirSync(newDir, { recursive: true });
    extract(archivePath, newDir, platform);
    const scriptPath = writeUpdateScript(tmp, newDir, installRoot, exe, platform);
    launchUpdater(scriptPath, platform);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

module.exports = { checkForUpdate, applyUpdate, pickAsset, compareVersions, parseVersion, GITHUB_REPO };
