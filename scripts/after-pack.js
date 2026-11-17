// electron-builder afterPack 钩子：每个平台只保留自己需要的 ossutil 二进制，
// 删除其余平台的冗余二进制，减小安装包体积。
const fs = require('fs');
const path = require('path');

const KEEP = {
  darwin: { x64: 'mac-amd64', arm64: 'mac-arm64' },
  win32: { x64: 'windows-amd64', ia32: 'windows-amd64' },
  linux: { x64: 'linux-amd64', arm64: 'linux-arm64', armv7l: 'linux-arm64' },
};

function archName(context) {
  try {
    const { Arch } = require('builder-util');
    return Arch[context.arch];
  } catch (e) {
    return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch];
  }
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = archName(context);
  const keep = KEEP[platform] && KEEP[platform][arch];
  if (!keep) {
    console.log(`afterPack: 跳过（${platform}/${arch}）`);
    return;
  }

  let resDir;
  if (platform === 'darwin') {
    const appDir = fs.readdirSync(context.appOutDir).find((f) => f.endsWith('.app'));
    if (!appDir) return;
    resDir = path.join(context.appOutDir, appDir, 'Contents', 'Resources', 'ossutil');
  } else {
    resDir = path.join(context.appOutDir, 'resources', 'ossutil');
  }

  if (!fs.existsSync(resDir)) return;
  const removed = [];
  for (const d of fs.readdirSync(resDir)) {
    const full = path.join(resDir, d);
    if (fs.statSync(full).isDirectory() && d !== keep) {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(d);
    }
  }
  console.log(`afterPack: 保留 ossutil/${keep}，移除冗余二进制 [${removed.join(', ') || '无'}]`);
};
