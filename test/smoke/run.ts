import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SmokeTestRun } from '../automation/smokeProcess.ts';

const desktopDirectory = resolve(import.meta.dirname, '../..');
const project = process.argv[2];
const projects = ['browser-ui', 'browser-app-server', 'electron-ui', 'electron-app-server', 'electron-editor-app-server', 'electron-pdf-corpus-app-server'];
const args = process.argv.slice(3);
// pnpm preserves an npm-style separator; Playwright excludes everything after
// it from file/title filters. Normalize only the leading package-manager separator.
if (args[0] === '--') args.shift();
if (!projects.includes(project) || args.includes('--')) {
	throw new Error(`Usage: node test/smoke/run.ts <${projects.join('|')}> [file] [--grep pattern]. Do not put -- between Playwright arguments.`);
}
for (let index = 0; index < args.length; index++) {
	const argument = args[index];
	if (/^(--grep|--grep-invert|-g|-G)(=|$)/u.test(argument)) {
		const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[index + 1];
		if (!value?.trim() || value.startsWith('--')) throw new Error(`Smoke test filter ${argument} requires a nonempty pattern.`);
	}
}
if (args.includes('--pass-with-no-tests')) throw new Error('Smoke tests must fail when no tests match.');
if (args.some(argument => /^--ui(?:$|[=-])/u.test(argument))) throw new Error('Smoke runner does not support Playwright UI mode; use --debug for interactive debugging.');

const directory = await mkdtemp(join(tmpdir(), 'ash-smoke-run-'));
const run = new SmokeTestRun(desktopDirectory, directory);
let interruption: number | undefined;
const onInterrupt = (): void => { interruption ??= 130; void run.stop('SIGINT').catch(() => { /* Reported by close below. */ }); };
const onTerminate = (): void => { interruption ??= 143; void run.stop('SIGTERM').catch(() => { /* Reported by close below. */ }); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
const browserMode = process.env.ASH_PLAYWRIGHT_SERVER === 'development' ? 'development' : 'disconnected';
const environment: NodeJS.ProcessEnv = {
	...process.env,
	ASH_SMOKE_RUN_DIRECTORY: directory,
	ASH_PLAYWRIGHT_SERVER: project === 'browser-ui' ? browserMode : project === 'browser-app-server' ? 'full' : undefined,
};
try {
	const cli = ['node_modules/@playwright/test/cli.js', 'test', `--project=${project}`, ...args];
	// Collect before launching product processes. Unknown options and zero matches
	// fail here; the reported count makes the effective scope reviewable.
	const selection = await run.command(process.execPath, [...cli, '--list', '--reporter=list'], environment, true);
	if (selection.code !== 0) {
		process.stdout.write(selection.output);
		process.exitCode = selection.code;
	} else {
		const help = args.includes('--help') || args.includes('-h');
		const count = Number(selection.output.match(/Total: (\d+) tests? in /u)?.[1]);
		if (!help && !count) throw new Error(`Smoke test collection did not select any tests.\n${selection.output}`);
		if (help || args.includes('--list')) {
			process.stdout.write(selection.output);
		} else {
			console.log(`Smoke selection: ${count} tests (${project}).`);
			if (project.includes('app-server')) {
				const languageServer = join(directory, process.platform === 'win32' ? 'ash-test-language-server.exe' : 'ash-test-language-server');
				const result = await run.command('rustc', ['--edition=2024', 'test/fixtures/language_server.rs', '-o', languageServer], environment);
				if (result.code !== 0) throw new Error(`Language-server fixture compilation failed: ${result.code}`);
				environment.ASH_PLAYWRIGHT_LANGUAGE_SERVER = languageServer;
			}
			process.exitCode = (await run.command(process.execPath, cli, environment)).code;
		}
	}
} catch (error) {
	if (!run.stopped) { console.error(error); process.exitCode = 1; }
} finally {
	try { await run.close(); if (interruption) process.exitCode = interruption; }
	catch (error) { console.error(error); process.exitCode = 1; }
	finally {
		process.off('SIGINT', onInterrupt);
		process.off('SIGTERM', onTerminate);
		await rm(directory, { force: true, recursive: true });
	}
}
