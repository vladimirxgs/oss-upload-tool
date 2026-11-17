const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 每次上传的本地状态汇总存放目录（应用数据目录，不混入数据集）。
function historyDir() {
  return path.join(app.getPath('userData'), 'upload-history');
}

// 写一份汇总 JSON，返回文件路径。
function writeSummary(record) {
  const dir = historyDir();
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = String(record.type || 'upload').replace(/[^\w-]/g, '');
  const file = path.join(dir, `${ts}-${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8' });
  return file;
}

module.exports = { historyDir, writeSummary };
