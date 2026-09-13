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
	'../.build/desktop/test/src/ash/editor/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/contrib/academic/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/contrib/codeEditor/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/contrib/multiDiffEditor/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/contrib/bulkEdit/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/contrib/documentEditor/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/services/documentCollaboration/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/services/language/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/services/textMate/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/services/textfile/**/test/**/*.test.js',
	'../.build/desktop/test/src/ash/workbench/services/workingCopy/**/test/**/*.test.js',
], {
	cwd: desktopDirectory,
	stdio: 'inherit',
});

if (result.error) {
	throw result.error;
}
process.exitCode = result.status ?? 1;
