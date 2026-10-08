import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const planPath = resolve(root, '.build/ci/frontend.json');
const smokeRoot = 'test/smoke/areas/';
const coreTitles = [
	'Electron UI opens without preparing the App Server package',
	'Quick Access runs an exact command ID and can reopen for another command',
	'editor Enter preserves indentation and undo restores the input position',
	'startup marks record shell readiness and completed restoration in the running workbench',
];
const connectedTitle = 'text-file saves retain UTF-8 BOM and CRLF, and external reloads remain undoable';

interface FrontendPlan {
	full: boolean;
	connected: boolean;
	files: string[];
}

// These are product owners, not an import graph: smoke tests drive a separately
// built application, so Playwright's test-import dependency graph is insufficient.
const regions: readonly [RegExp, RegExp, boolean][] = [
	[/^src\/ash\/editor\//, /\/editor\/|\/academic\//, true],
	[/^src\/ash\/sessions\//, /\/sessions\/|\/chat\//, false],
	[/^src\/ash\/workbench\/contrib\/chat\//, /\/chat\/|\/sessions\//, false],
	[/^src\/ash\/workbench\/contrib\/search\//, /\/search\/|\/windows\/search/, true],
	[/^src\/ash\/workbench\/contrib\/(?:terminal|tasks|debug|testing)\//, /\/(?:tasks|debug|testing)\/|\/windows\/terminal/, true],
	[/^src\/ash\/workbench\/contrib\/(?:scm|git)\//, /\/windows\/(?:scm-|git-)/, true],
	[/^src\/ash\/workbench\/contrib\/themes\//, /\/windows\/(?:themes|icon-size)\./, false],
	[/^src\/ash\/workbench\/contrib\/preferences\//, /\/windows\/.*(?:settings|keybindings|display-language)/, false],
	[/^src\/ash\/workbench\/contrib\/browserView\//, /\/windows\/browser-/, false],
];

function frontendTestPlan(paths: readonly string[], full: boolean, smokeFiles: readonly string[]): FrontendPlan {
	if (full) { return { full: true, connected: true, files: [] }; }
	const selected = new Set<string>();
	let connected = false;
	for (const path of paths) {
		if (path.endsWith('.md')) { continue; }
		if (path.startsWith(smokeRoot)) {
			// Deleted specs still exercise their surviving area rather than selecting zero tests.
			const area = path.slice(0, path.lastIndexOf('/') + 1);
			for (const file of smokeFiles) { if (file === path || (!smokeFiles.includes(path) && file.startsWith(area))) { selected.add(file); } }
			connected = true;
			continue;
		}
		const region = regions.find(([source]) => source.test(path));
		if (region) {
			for (const file of smokeFiles) { if (region[1].test(file)) { selected.add(file); } }
			connected ||= (region[2] && !path.endsWith('.css')) || /\/(?:node|electron-main|electron-utility)\//.test(path);
			continue;
		}
		if (/^(?:crates\/|\.cargo\/|Cargo\.|rust-toolchain|src\/ash\/platform\/)/.test(path)) {
			connected = true;
		}
	}
	// Cross-cutting changes retain all Linux units/browser integration plus the
	// platform core. Exhaustive application regression belongs to main/manual runs.
	return { full: false, connected, files: [...selected].sort() };
}

function smokeFiles(directory: string): string[] {
	return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) { return smokeFiles(path); }
		return entry.name.endsWith('.spec.ts') && !['release-package.spec.ts', 'pdf-academic-corpus.spec.ts'].includes(entry.name) ? [path] : [];
	});
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
		const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
		const full = process.env.GITHUB_EVENT_NAME !== 'pull_request';
		let paths: string[] = [];
		if (!full) {
			const base = event.pull_request?.base?.sha;
			if (typeof base !== 'string' || !/^[a-f0-9]{40}$/.test(base)) { throw new Error('PR test selection requires its exact base SHA'); }
			execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], { cwd: root, stdio: 'inherit' });
			paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
		}
		const plan = frontendTestPlan(paths, full, smokeFiles(smokeRoot.replace(/\/$/, '')));
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
			const titles = connected ? [connectedTitle, coreTitles[1], coreTitles[2]] : coreTitles;
			const pattern = titles.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
			run(project, ['--grep', `(?:${pattern})$`, '--max-failures=1', ...process.argv.slice(4)]);
			if (plan.files.length) {
				for (const file of plan.files) { if (!existsSync(resolve(root, file))) { throw new Error(`Selected smoke file disappeared: ${file}`); } }
				// This one-test file is already covered by the mandatory UI core run.
				const files = plan.files.filter(file => file !== `${smokeRoot}windows/ui-only-startup.spec.ts`).map(file => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
				if (files.length) { run(project, [...files, '--grep-invert', `(?:${pattern})$`, '--max-failures=1', ...process.argv.slice(4)]); }
			}
		}
	} else { throw new Error('Usage: node build/frontend.ts <plan|test project>'); }
}
