import { withProcessRun } from '../processes.ts';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('macOS package verification requires a macOS arm64 or x64 host');
const appRoot = resolve(import.meta.dirname, '../..');
const bundle = resolve(appRoot, 'dist', `Ash-darwin-${process.arch}`, 'Ash.app');
await withProcessRun(appRoot, async (run, environment) => {
	process.exitCode = (await run.command(process.execPath, [join(appRoot, 'test/smoke/run.ts'), 'electron-ui', ...process.argv.slice(2), 'test/smoke/areas/windows/packaged-app.spec.ts'], {
		...environment, ASH_PACKAGED_BUNDLE: bundle,
	})).code;
});
