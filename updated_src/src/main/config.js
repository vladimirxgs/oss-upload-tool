const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

// 应用自身配置：endpoint / AccessKey / 城市缩写 / 房间号
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// ossutil 原生配置文件，写到各平台标准位置 ~/.ossutilconfig
// （mac/linux: $HOME/.ossutilconfig；windows: %USERPROFILE%\.ossutilconfig），
// os.homedir() 会自动对应到当前运行平台的正确用户目录。
function ossutilConfigPath() {
  return path.join(os.homedir(), '.ossutilconfig');
}

function emptyConfig() {
  return { endpoint: '', accessKeyID: '', accessKeySecret: '', city: '', roomId: '', bucket: 'hw-upload' };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const cfg = JSON.parse(raw);
    return {
      endpoint: cfg.endpoint || '',
      accessKeyID: cfg.accessKeyID || '',
      accessKeySecret: cfg.accessKeySecret || '',
      city: cfg.city || '',
      roomId: cfg.roomId || '',
      bucket: cfg.bucket || 'hw-upload',
    };
  } catch {
    return emptyConfig();
  }
}

function saveConfig(cfg) {
  const c = {
    endpoint: (cfg.endpoint || '').trim(),
    accessKeyID: (cfg.accessKeyID || '').trim(),
    accessKeySecret: (cfg.accessKeySecret || '').trim(),
    city: String(cfg.city || '').toUpperCase().replace(/[^A-Z]/g, ''), // 统一转大写并只保留字母
    roomId: String(cfg.roomId || '').trim().replace(/\D/g, ''),         // 只保留数字
    bucket: (cfg.bucket || 'hw-upload').trim() || 'hw-upload',
  };

  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 });

  // 生成 ossutil 原生配置（language=EN 保证输出为英文，便于解析）
  const content = [
    '[Credentials]',
    'language=EN',
    `endpoint=${c.endpoint}`,
    `accessKeyID=${c.accessKeyID}`,
    `accessKeySecret=${c.accessKeySecret}`,
    '',
  ].join('\n');
  fs.writeFileSync(ossutilConfigPath(), content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath(), 0o600);
    fs.chmodSync(ossutilConfigPath(), 0o600);
  }

  return c;
}

function isConfigured(cfg) {
  return !!(cfg && cfg.endpoint && cfg.accessKeyID && cfg.accessKeySecret);
}

module.exports = { loadConfig, saveConfig, isConfigured, ossutilConfigPath };
