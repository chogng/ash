import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('macOS package verification requires a macOS arm64 or x64 host');
const appRoot = resolve(import.meta.dirname, '../../app-ts');
const bundle = resolve(appRoot, '..', 'dist', `Ash-darwin-${process.arch}`, 'Ash.app');
const playwright = join(appRoot, 'node_modules', '@playwright', 'test', 'cli.js');
await new Promise<void>((done, fail) => {
	const child = spawn(process.execPath, [playwright, 'test', 'test/smoke/areas/windows/packaged-app.spec.ts', '--project=electron-ui'], {
		cwd: appRoot,
		stdio: 'inherit',
		windowsHide: true,
		env: { ...process.env, ASH_PACKAGED_BUNDLE: bundle },
	});
	child.once('error', fail);
	child.once('close', (code, signal) => code === 0 ? done() : fail(new Error(`macOS package verification ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`)));
});
