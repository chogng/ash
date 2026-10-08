import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (!process.env.CI || process.argv.includes('--install')) {
	const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
	if (current.status !== 0 && current.status !== 1) { throw new Error('Cannot read Git hook configuration'); }
	const path = current.stdout.trim();
	if (path && path !== '.githooks') {
		throw new Error(`Existing Git hooks at ${path}; add the import-case checks there before enabling repository hooks.`);
	}
	const installed = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
	if (installed.status !== 0) { throw new Error('Cannot install repository Git hooks'); }
	console.log('Installed local staged and pre-push import-case checks.');
}
