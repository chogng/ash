import { join, resolve } from 'node:path';
import { withProcessRun } from '../../build/processes.ts';
import { collectTests, playwrightArguments } from '../../build/playwright.ts';

const desktopDirectory = resolve(import.meta.dirname, '../..');
const project = process.argv[2];
const projects = ['browser-ui', 'browser-app-server', 'electron-ui', 'electron-app-server', 'electron-editor-app-server', 'electron-pdf-corpus-app-server', 'electron-release'];
if (!projects.includes(project)) throw new Error(`Unknown smoke project: ${project}`);
const args = playwrightArguments(process.argv.slice(3));
const browserMode = process.env.ASH_PLAYWRIGHT_SERVER === 'development' ? 'development' : 'disconnected';
await withProcessRun(desktopDirectory, async (run, environment) => {
	environment.ASH_PLAYWRIGHT_SERVER = project === 'browser-ui' ? browserMode : project === 'browser-app-server' ? 'full' : undefined;
	const cli = ['node_modules/@playwright/test/cli.js', 'test', `--project=${project}`, ...args];
	if (!(await collectTests(run, cli, args, environment))) return;
	if (project.includes('app-server')) {
		const languageServer = join(environment.ASH_SMOKE_RUN_DIRECTORY!, process.platform === 'win32' ? 'ash-test-language-server.exe' : 'ash-test-language-server');
		const result = await run.command('rustc', ['--edition=2024', 'test/fixtures/language_server.rs', '-o', languageServer], environment);
		if (result.code !== 0) throw new Error(`Language-server fixture compilation failed: ${result.code}`);
		environment.ASH_PLAYWRIGHT_LANGUAGE_SERVER = languageServer;
	}
	process.exitCode = (await run.command(process.execPath, cli, environment)).code;
});
