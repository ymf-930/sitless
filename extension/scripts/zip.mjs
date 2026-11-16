import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const zip = resolve(root, 'sitless-extension.zip');

if (existsSync(zip)) rmSync(zip);
const ps = `Compress-Archive -Path '${dist}\\*' -DestinationPath '${zip}' -Force`;
execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
console.log('zip ready:', zip);
