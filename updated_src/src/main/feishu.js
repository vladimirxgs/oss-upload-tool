const https = require('https');
const http = require('http');
const crypto = require('crypto');

// 发送飞书「群自定义机器人」消息（webhook，无需自建应用 / 审批定义）。
// 安全设置支持：自定义关键词（自动补全到消息里）与签名校验（自动加签）。
function sendWebhook(cfg, content) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(cfg.webhookUrl); }
    catch { reject(new Error('webhook 地址无效')); return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') { reject(new Error('webhook 地址需以 https:// 开头')); return; }

    // 机器人安全设置选了「自定义关键词」时，消息必须包含该关键词，缺失则补到最前面
    let text = String(content || '');
    if (cfg.keyword && !text.includes(cfg.keyword)) text = cfg.keyword + '\n' + text;

    const body = { msg_type: 'text', content: { text } };
    if (cfg.secret) {
      // 飞书签名：stringToSign = timestamp + "\n" + secret；sign = base64(HMAC-SHA256(key=stringToSign, data=""))
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sign = crypto.createHmac('sha256', `${timestamp}\n${cfg.secret}`).update('').digest('base64');
      body.timestamp = timestamp;
      body.sign = sign;
    }

    const data = JSON.stringify(body);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch {}
        const code = parsed ? (parsed.code ?? parsed.StatusCode ?? parsed.status_code ?? parsed.Code) : undefined;
        const ok = res.statusCode >= 200 && res.statusCode < 300 && (parsed == null || code === 0);
        if (ok) resolve();
        else {
          const msg = parsed && (parsed.msg || parsed.StatusMessage || parsed.status_message || parsed.Msg);
          reject(new Error('发送飞书消息失败：' + (msg || ('HTTP ' + res.statusCode)) + (buf ? ' ' + buf.slice(0, 200) : '')));
        }
      });
    });
    req.on('error', (err) => reject(new Error('飞书网络请求失败: ' + err.message)));
    req.write(data);
    req.end();
  });
}

module.exports = { sendWebhook };
