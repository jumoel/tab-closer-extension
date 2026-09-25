import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
  'manifest.json', 'background.js', 'rules.js', 'options.html', 'options.js', 'options.css',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png', 'LICENSE'
];
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const parts = typeof version === 'string' ? version.split('.') : [];
if (parts.length < 1 || parts.length > 4 ||
    parts.some(part => !/^(0|[1-9]\d*)$/.test(part) || Number(part) > 65535) ||
    parts.every(part => Number(part) === 0)) {
  throw new Error('manifest.json has an invalid extension version');
}
for (const file of files) {
  if (!statSync(join(root, file)).isFile()) throw new Error(`${file} is not a file`);
}

const output = join(root, 'dist', `tab-closer-${version}.zip`);
mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });
const result = spawnSync('zip', ['-q', '-X', output, ...files], { cwd: root, stdio: 'inherit' });
if (result.error?.code === 'ENOENT') throw new Error('zip is required to package the extension');
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`zip exited with status ${result.status}`);
console.log(output);
