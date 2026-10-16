import { withProcessRun } from '../../../build/processes.ts';
import { collectTests, playwrightArguments } from '../../../build/playwright.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import sirv from 'sirv';

const desktopDirectory = resolve(import.meta.dirname, '../../..');
const editorOnly = process.argv[2] === '--editor';
const playwrightArgs = playwrightArguments(process.argv.slice(editorOnly ? 3 : 2));
const testArgs = [
	'node_modules/@playwright/test/cli.js',
	'test',
	'--config',
	'test/integration/browser/playwright.config.ts',
	...playwrightArgs,
];
await withProcessRun(desktopDirectory, async (run, environment) => {
	const testEnv = {
		...environment,
		ASH_EDITOR_BROWSER_ONLY: editorOnly ? '1' : '0',
		ASH_EDITOR_BROWSER_EXTERNAL_SERVER: '1',
	};
	if (!await collectTests(run, testArgs, playwrightArgs, testEnv)) return;
	const files = playwrightArgs.filter(argument => /\.spec\.[jt]s$/u.test(argument));
	let syntaxExecutable: string | undefined;
	if (files.length === 0 || files.some(file => /(?:treeSitter|tokenization|themes|textModel)\.integration\.spec\.[jt]s$/u.test(file))) {
		const prepared = await run.command('pnpm', ['run', 'prepare:backend'], testEnv);
		if (prepared.code !== 0) { process.exitCode = prepared.code; return; }
		const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-gnu'}`;
		const metadata = JSON.parse(readFileSync(resolve(desktopDirectory, '.build/runtime/dev/store-v1', target, 'host-provided-node/dev-small/prepare-inputs.json'), 'utf8')) as { packageRoot: string; };
		// Pin the immutable package, so another build cannot replace the backend during this run.
		syntaxExecutable = resolve(metadata.packageRoot, 'bin', `ash-app-server${process.platform === 'win32' ? '.exe' : ''}`);
	}
	const outputParent = resolve(desktopDirectory, '.build/desktop');
	mkdirSync(outputParent, { recursive: true });
	// Another build can clear the shared output while the server is reading it.
	const assetsDirectory = mkdtempSync(resolve(outputParent, 'editor-browser-'));
	const resultsDirectory = resolve(outputParent, 'playwright', basename(assetsDirectory));
	let server: Server | undefined;
	let exitCode = 1;
	try {
		const build = await run.command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'test/integration/browser/vite.config.ts', '--outDir', assetsDirectory], testEnv);
		if (build.code !== 0) {
			exitCode = build.code;
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
			exitCode = (await run.command(process.execPath, testArgs, {
				...testEnv,
				...(syntaxExecutable ? { ASH_TEST_SYNTAX_APP_SERVER: syntaxExecutable } : {}),
				ASH_EDITOR_BROWSER_BASE_URL: serverUrl,
				ASH_EDITOR_BROWSER_RUN_DIRECTORY: resultsDirectory,
			})).code;
		}
	} finally {
		if (server) await stop(server);
		rmSync(assetsDirectory, { recursive: true, force: true });
	}

	process.exitCode = exitCode;

});

async function stop(server: Server): Promise<void> {
	const closed = new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
	server.closeAllConnections();
	await closed;
}
