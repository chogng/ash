import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { stylelint } from './stylelint.ts';

const root = resolve(import.meta.dirname, '..');
const packageManager = process.env.npm_execpath;
if (!packageManager) {
	throw new Error('Run this check through pnpm hygiene.');
}
process.exitCode = stylelint();
if (process.exitCode === 0) {
	// Registry consistency uses the normal frontend compiler and test environment.
	const isScript = /\.[cm]?js$/.test(packageManager);
	const executable = isScript ? process.execPath : packageManager;
	const prefix = isScript ? [packageManager] : [];
	const result = spawnSync(executable, [
		...prefix, '--dir', 'app-ts', 'test:unit',
		'--run', 'src/ash/workbench/test/common/design-tokens.test.ts',
	], { cwd: root, stdio: 'inherit', windowsHide: true });
	if (result.error) {
		throw result.error;
	}
	process.exitCode = result.status ?? 1;
}
