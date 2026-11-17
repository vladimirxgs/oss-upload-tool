// 从 core/*.zip 解压 ossutil 二进制到 resources/ossutil/<platform>/
// 运行: npm run prepare（npm install 时也会自动触发）
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'core');
const OUT_DIR = path.join(ROOT, 'resources', 'ossutil');

const PLATFORMS = [
  { zip: 'ossutil-v1.7.19-mac-amd64.zip',     dir: 'mac-amd64',     bin: 'ossutil' },
  { zip: 'ossutil-v1.7.19-mac-arm64.zip',     dir: 'mac-arm64',     bin: 'ossutil', optional: true },
  { zip: 'ossutil-v1.7.19-windows-amd64.zip', dir: 'windows-amd64', bin: 'ossutil.exe' },
  { zip: 'ossutil-v1.7.19-linux-amd64.zip',   dir: 'linux-amd64',   bin: 'ossutil' },
  { zip: 'ossutil-v1.7.19-linux-arm64.zip',   dir: 'linux-arm64',   bin: 'ossutil' },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const done = [];
  const skipped = [];

  for (const p of PLATFORMS) {
    const zipPath = path.join(CORE_DIR, p.zip);
    if (!fs.existsSync(zipPath)) {
      if (p.optional) {
        skipped.push(p.zip);
        continue;
      }
      console.error(`✘ 缺少 ${p.zip}，请先放到 core/ 目录`);
      process.exitCode = 1;
      continue;
    }

    const zip = new AdmZip(zipPath);
    const entry = zip
      .getEntries()
      .find((e) => !e.isDirectory && path.basename(e.entryName) === p.bin);
    if (!entry) {
      console.error(`✘ ${p.zip} 中找不到 ${p.bin}`);
      process.exitCode = 1;
      continue;
    }

    const outDir = path.join(OUT_DIR, p.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, p.bin);
    fs.writeFileSync(outPath, entry.getData());
    if (p.bin !== 'ossutil.exe') fs.chmodSync(outPath, 0o755);
    done.push(`${p.dir}/${p.bin}`);
  }

  console.log('✔ ossutil 二进制已就绪:', done.join(', '));
  if (skipped.length) console.log('⚠ 跳过（可选，未提供 zip）:', skipped.join(', '));
}

main();
