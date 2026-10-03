import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktopDirectory = resolve(import.meta.dirname, '../..');
// Preparation builds the product once; each Playwright scenario owns its backend and data.
const mode = process.argv[2];
if (mode !== 'disconnected' && mode !== 'full') {
	throw new Error('Usage: node test/smoke/browser.ts <disconnected|full>');
}
const fixtureDirectory = mode === 'full' && !process.env.ASH_PLAYWRIGHT_RUST_ANALYZER
	? await mkdtemp(join(tmpdir(), 'ash-language-server-')) : undefined;
try {
	let languageServer = process.env.ASH_PLAYWRIGHT_RUST_ANALYZER;
	if (fixtureDirectory) {
		languageServer = join(fixtureDirectory, process.platform === 'win32' ? 'ash-test-language-server.exe' : 'ash-test-language-server');
		const result = await run('rustc', ['--edition=2024', 'test/fixtures/language-server.rs', '-o', languageServer], process.env);
		if (result !== 0) { throw new Error(`Language-server fixture compilation failed: ${result}`); }
	}
	process.exitCode = await run(process.execPath, [
		'node_modules/@playwright/test/cli.js', 'test',
		`--project=${mode === 'full' ? 'browser-app-server' : 'browser-ui'}`,
		...process.argv.slice(3),
	], {
		...process.env,
		ASH_PLAYWRIGHT_SERVER: mode,
		...(languageServer ? { ASH_PLAYWRIGHT_LANGUAGE_SERVER: languageServer } : {}),
	});
} finally {
	if (fixtureDirectory) { await rm(fixtureDirectory, { force: true, recursive: true }); }
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolveExit, reject) => {
		const child = spawn(command, args, { cwd: desktopDirectory, env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (signal) { reject(new Error(`Web integration command exited with signal ${signal}`)); }
			else { resolveExit(code ?? 1); }
		});
	});
}
