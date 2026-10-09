import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ciChanges } from './ciChanges.ts';

const root = resolve(import.meta.dirname, '..');
const planPath = resolve(root, '.build/ci/frontend.json');
const coreTitles = [
	'Electron UI opens without preparing the App Server package',
	'Quick Access runs an exact command ID and can reopen for another command',
	'editor Enter preserves indentation and undo restores the input position',
	'startup marks record shell readiness and completed restoration in the running workbench',
];
const connectedTitles = [
	'text-file saves retain UTF-8 BOM and CRLF, and external reloads remain undoable',
	'task discovery does not execute commands and explicit run and rerun use the workspace terminal',
	'terminating a running workspace task stops its terminal and records cancellation',
	coreTitles[1]!,
	coreTitles[2]!,
];

interface FrontendPlan {
	full: boolean;
	connected: boolean;
}

function frontendTestPlan(paths: readonly string[] | undefined, surface: string): FrontendPlan {
	if (!paths) { return { full: true, connected: true }; }
	// PRs build the real backend once on Linux. Complete cross-platform and
	// feature-area application regression remains main/manual acceptance.
	const backendChanged = paths.some(path => !/\.(?:md|css)$/.test(path) && (
		/^crates\/(?!tui\/)/.test(path)
		|| /^(?:\.cargo\/|Cargo\.|rust-toolchain|third_party\/livekit\/)/.test(path)
		|| /^build\/(?:lib\/|prepare\.py$|protocol\/|desktop\/(?:develop|ci)\.py$)/.test(path)
		|| /^src\/ash\/(?:platform\/|editor\/|workbench\/(?:services\/|contrib\/(?:tasks|terminal|search|scm|git)\/))/.test(path)
		|| /\/(?:node|electron-main|electron-utility)\//.test(path)
	));
	return { full: false, connected: surface === 'browser' && backendChanged };
}

function run(project: string, args: readonly string[]): void {
	const ui = project === 'electron-ui';
	const command = ui ? ['node_modules/@playwright/test/cli.js', 'test', `--project=${project}`] : ['test/smoke/run.ts', project];
	const result = spawnSync(process.execPath, [...command, ...args], { cwd: root, env: process.env, stdio: 'inherit' });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { process.exit(result.status ?? 1); }
}

if (import.meta.main) {
	const command = process.argv[2];
	if (command === 'plan') {
		const surface = process.argv[3] ?? 'browser';
		if (!['browser', 'electron'].includes(surface)) { throw new Error('Expected browser or electron surface'); }
		const paths = ciChanges(root);
		const plan = frontendTestPlan(paths, surface);
		mkdirSync(resolve(root, '.build/ci'), { recursive: true });
		writeFileSync(planPath, JSON.stringify(plan));
		if (process.env.GITHUB_OUTPUT) { appendFileSync(process.env.GITHUB_OUTPUT, `connected=${plan.connected}\n`); }
		console.log(JSON.stringify({ ...plan, changed: paths }, null, 2));
	} else if (command === 'test') {
		const project = process.argv[3];
		if (!['electron-ui', 'electron-app-server', 'browser-ui', 'browser-app-server'].includes(project)) { throw new Error('Expected a configured CI smoke project'); }
		const plan: FrontendPlan = JSON.parse(readFileSync(planPath, 'utf8'));
		const connected = project.endsWith('app-server');
		if (connected && !plan.connected) { throw new Error('Connected tests require backend preparation'); }
		if (plan.full) { run(project, process.argv.slice(4)); }
		else {
			const titles = connected ? connectedTitles : coreTitles;
			const pattern = titles.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
			run(project, ['--grep', `(?:${pattern})$`, '--max-failures=1', ...process.argv.slice(4)]);
		}
	} else { throw new Error('Usage: node build/frontend.ts <plan|test project>'); }
}
