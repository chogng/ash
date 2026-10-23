import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import sirv from 'sirv';
import type { ProcessRun } from '../../../build/processes.ts';

/** The runner owns the build and HTTP lifetime, shared by its isolated Mocha workers. */
export async function startBrowserUnitServer(run: ProcessRun, environment: NodeJS.ProcessEnv) {
	const root = resolve(import.meta.dirname, '../../..');
	const assets = mkdtempSync(resolve(root, '.build/desktop/unit-browser-'));
	const build = await run.command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'test/unit/browser/vite.config.ts', '--outDir', assets], environment);
	if (build.code !== 0) {
		rmSync(assets, { recursive: true, force: true });
		throw new Error('Browser unit fixture build failed.');
	}
	const serve = sirv(assets, { etag: true });
	const server = createServer(serve);
	await new Promise<void>((resolveReady, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveReady(); });
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Browser unit server requires TCP.');
	return {
		url: `http://127.0.0.1:${address.port}`,
		results: resolve(root, '.build/desktop/playwright', basename(assets)),
		async dispose(): Promise<void> {
			const closed = new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
			server.closeAllConnections();
			await closed;
			rmSync(assets, { recursive: true, force: true });
		},
	};
}
