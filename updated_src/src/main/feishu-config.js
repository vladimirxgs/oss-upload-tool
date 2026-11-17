const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 项目负责人飞书「群自定义机器人」webhook 配置，单独存 userData/feishu.json，与 OSS 配置解耦。
function configPath() {
  return path.join(app.getPath('userData'), 'feishu.json');
}

function emptyConfig() {
  return {
    webhookUrl: '', // 群自定义机器人 webhook 地址（https://open.feishu.cn/open-apis/bot/v2/hook/xxx）
    keyword: '',    // 机器人「自定义关键词」安全设置的关键词（可选，发送时确保消息包含它）
    secret: '',     // 机器人「签名校验」安全设置的密钥（可选，填写后自动加签）
  };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...emptyConfig(), ...JSON.parse(raw) };
  } catch {
    return emptyConfig();
  }
}

function saveConfig(cfg) {
  const c = {
    webhookUrl: (cfg.webhookUrl || '').trim(),
    keyword: (cfg.keyword || '').trim(),
    secret: (cfg.secret || '').trim(),
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(configPath(), 0o600);
  return c;
}

function isConfigured(cfg) {
  return !!(cfg && cfg.webhookUrl);
}

module.exports = { loadConfig, saveConfig, isConfigured };
