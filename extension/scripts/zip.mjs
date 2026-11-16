import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const zip = resolve(root, 'sitless-extension.zip');

if (existsSync(zip)) rmSync(zip);

// Windows 走 PowerShell；其他平台用 zip，没有就跳过（dist 本身已可直接加载）。
if (process.platform === 'win32') {
  const ps = `Compress-Archive -Path '${dist}\\*' -DestinationPath '${zip}' -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
} else {
  try {
    execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: dist, stdio: 'inherit' });
  } catch {
    console.warn('未找到 zip 命令，跳过打包；dist/ 可直接加载');
    process.exit(0);
  }
}

console.log('zip ready:', zip);
