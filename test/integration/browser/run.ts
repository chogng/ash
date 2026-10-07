import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import sirv from 'sirv';

const desktopDirectory = resolve(import.meta.dirname, '../../..');
const editorOnly = process.argv[2] === '--editor';
const playwrightArgs = process.argv.slice(editorOnly ? 3 : 2);
const testArgs = [
	'node_modules/@playwright/test/cli.js',
	'test',
	'--config',
	'test/integration/browser/playwright.config.ts',
	...playwrightArgs,
];
const testEnv = {
	...process.env,
	ASH_EDITOR_BROWSER_ONLY: editorOnly ? '1' : '0',
	ASH_EDITOR_BROWSER_EXTERNAL_SERVER: '1',
};
// Listing only discovers specs; it needs neither browser assets nor a running server.
if (playwrightArgs.includes('--list')) {
	process.exit(await run(process.execPath, testArgs, testEnv));
}
const outputParent = resolve(desktopDirectory, '.build/desktop');
mkdirSync(outputParent, { recursive: true });
// Another build can clear the shared output while the server is reading it.
const assetsDirectory = mkdtempSync(resolve(outputParent, 'editor-browser-'));
const resultsDirectory = resolve(outputParent, 'playwright', basename(assetsDirectory));
let server: Server | undefined;
let exitCode = 1;
try {
	const build = await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'test/integration/browser/vite.config.ts', '--outDir', assetsDirectory], process.env);
	if (build !== 0) {
		exitCode = build;
	} else {
		server = createServer(sirv(assetsDirectory, { etag: true }));
		await new Promise<void>((resolvePromise, reject) => {
			server!.once('error', reject);
			server!.listen(0, '127.0.0.1', () => {
				server!.off('error', reject);
				resolvePromise();
			});
		});
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Editor browser server requires a TCP address');
		const serverUrl = `http://127.0.0.1:${address.port}`;
		console.log(`Browser integration server: ${serverUrl}
Browser integration results: ${resultsDirectory}`);
		exitCode = await run(process.execPath, testArgs, {
			...testEnv,
			ASH_EDITOR_BROWSER_BASE_URL: serverUrl,
			ASH_EDITOR_BROWSER_RUN_DIRECTORY: resultsDirectory,
		});
	}
} finally {
	if (server) await stop(server);
	rmSync(assetsDirectory, { recursive: true, force: true });
}

process.exitCode = exitCode;

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise<number>((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: desktopDirectory, env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal) {
				reject(new Error(`Editor browser tests exited with signal ${signal}`));
				return;
			}
			resolvePromise(code ?? 1);
		});
	});
}

async function stop(server: Server): Promise<void> {
	const closed = new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
	server.closeAllConnections();
	await closed;
}
