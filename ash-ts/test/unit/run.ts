import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { requireNode25 } from '../../../build/lib/requireNode25.ts';

requireNode25();
const desktopDirectory = resolve(import.meta.dirname, '../..');
const result = spawnSync(process.execPath, [
	'--import',
	'./test/unit/ignore-css-imports.ts',
	'--import',
	'./test/unit/editor-environment.ts',
	'--test',
	'--test-concurrency=1',
	'--test-timeout=60000',
	...process.argv.slice(2),
	'../.build/desktop/test/src/ash/**/test/**/*.test.js',
	'../.build/desktop/test/test/architecture/*.test.js',
], {
	cwd: desktopDirectory,
	stdio: 'inherit',
	windowsHide: true,
});

if (result.error) {
	throw result.error;
}
process.exitCode = result.status ?? 1;
