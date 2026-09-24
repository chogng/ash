import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const desktopDirectory = resolve(import.meta.dirname, '../../..');
const serverUrl = 'http://127.0.0.1:5185/textModel.html';
// Keep the editor command focused while the full browser command covers every spec.
const editorSpecs = [
	'academic.integration.spec.ts',
	'diff.integration.spec.ts',
	'gpuText.integration.spec.ts',
	'iPadShowKeyboard.integration.spec.ts',
	'language.integration.spec.ts',
	'loading.integration.spec.ts',
	'standalone.integration.spec.ts',
	'textModel.integration.spec.ts',
	'themes.integration.spec.ts',
	'tokenization.integration.spec.ts',
];
const editorOnly = process.argv[2] === '--editor';
const playwrightArgs = process.argv.slice(editorOnly ? 3 : 2);
const build = await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'test/integration/browser/vite.config.ts'], process.env);
if (build !== 0) process.exit(build);
const server = spawn(process.execPath, [
	'../scripts/app_ts/web.ts',
	'../.build/app-ts/editor-browser',
	'5185',
], {
	cwd: desktopDirectory,
	stdio: 'inherit',
});

let exitCode = 1;
try {
	await waitForServer(serverUrl, server);
	exitCode = await run(process.execPath, [
		'node_modules/@playwright/test/cli.js',
		'test',
		'--config',
		'test/integration/browser/playwright.config.ts',
		...(editorOnly ? editorSpecs : []),
		...playwrightArgs,
	], {
		...process.env,
		ASH_EDITOR_BROWSER_EXTERNAL_SERVER: '1',
	});
} finally {
	await stop(server);
}

process.exitCode = exitCode;

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`Editor browser server exited with code ${child.exitCode}`);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) {
				return;
			}
		} catch {}
		await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
	}
	throw new Error(`Editor browser server did not become ready at ${url}`);
}

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

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	child.kill('SIGTERM');
	await Promise.race([
		new Promise(resolvePromise => child.once('exit', resolvePromise)),
		new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
	]);
	if (child.exitCode === null) {
		child.kill('SIGKILL');
	}
}
