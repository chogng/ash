import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { playwrightTargetForProject } from '../test/automation/testTarget.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/frontend.yml'), 'utf8');
const scripts: Record<string, string> = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')).scripts;
const execute = promisify(execFile);
const projects = [...workflow.matchAll(/pnpm run ([\w:-]+no-compile)\b/g)].map(match => {
	const project = scripts[match[1]]?.match(/^node test\/smoke\/run\.ts ([\w-]+)$/)?.[1];
	assert.ok(project, `Frontend CI smoke script has no project: ${match[1]}`);
	return project;
});

test('Frontend CI finishes main acceptance and cancels stale runs on other refs', () => {
	const concurrency = workflow.match(/^concurrency:\n((?:[ \t].*\n)+)/m)?.[1];
	assert.ok(concurrency, 'Frontend CI must retain its per-ref concurrency group');
	assert.match(concurrency, /^  group: frontend-\$\{\{ github\.ref \}\}$/m);
	assert.match(concurrency, /^  cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}$/m);
});

test('Frontend acceptance waits for shared contracts and unit tests', () => {
	for (const job of ['desktop-runtime', 'check']) {
		const definition = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z-]+:\n/u)[0];
		assert.match(definition, /^    needs: contracts$/m);
	}
	const contracts = workflow.split('\n  contracts:\n')[1].split(/\n  [a-z-]+:\n/u)[0];
	assert.match(contracts, /pnpm typecheck:renderer/u);
	assert.match(contracts, /pnpm test:build/u);
	assert.match(contracts, /pnpm test:unit/u);
});

test('Frontend CI smoke commands collect applicable tests from configured Playwright projects', { timeout: 30_000 }, async () => {
	assert.ok(projects.length > 0, 'Frontend CI must retain explicit smoke project selections');
	for (const project of projects) {
		assert.doesNotThrow(() => playwrightTargetForProject(project));
		const { stdout } = await execute(process.execPath, ['test/smoke/run.ts', project, 'test/smoke/areas/academic/academic-workbench.spec.ts', '--list'], { cwd: repositoryRoot, timeout: 10_000 });
		assert.match(stdout, /Total: [1-9]\d* tests? in [1-9]\d* files?/);
	}
});

test('Frontend CI retains Academic coverage in the unified Workbench projects', { timeout: 15_000 }, async () => {
	assert.ok(projects.includes('electron-ui'));
	assert.deepEqual(playwrightTargetForProject('electron-ui'), { kind: 'electron', appServerMode: 'disabled' });
	assert.ok(projects.includes('electron-app-server'));
	assert.deepEqual(playwrightTargetForProject('electron-app-server'), { kind: 'electron', appServerMode: 'required' });
	for (const [project, file] of [['electron-ui', 'academic/academic-workbench.spec.ts'], ['electron-app-server', 'editor/academic-open.spec.ts']]) {
		const { stdout } = await execute(process.execPath, ['test/smoke/run.ts', project, `test/smoke/areas/${file}`, '--list'], { cwd: repositoryRoot, timeout: 10_000 });
		assert.match(stdout, /Total: [1-9]\d* tests? in 1 file/);
	}
});

test('Frontend CI collects success, rejection, failure, revocation and close cases for both Task kinds', { timeout: 15_000 }, async () => {
	assert.match(workflow, /name: Test mock Agent process and shell Task execution\n\s+if: matrix.surface == 'electron'[\s\S]*?run: pnpm run test:smoke:desktop:no-compile test\/smoke\/areas\/tasks\/task-agent.spec.ts/u);
	const { stdout } = await execute(process.execPath, ['test/smoke/run.ts', 'electron-app-server', 'test/smoke/areas/tasks/task-agent.spec.ts', '--list'], { cwd: repositoryRoot, timeout: 10_000 });
	assert.match(stdout, /process › Mock Agent Task loop/u);
	assert.match(stdout, /shell › Mock Agent Task loop/u);
	for (const title of [
		'refuses a declined approval',
		'retains the failed Run ID',
		'rechecks revoked command permission',
		'releases the running process',
		'closes its process with the owning window',
		'discovers, runs, reads and cancels',
	]) {
		assert.equal(stdout.split('\n').filter(line => line.includes(title)).length, 2, title);
	}
	assert.match(stdout, /Total: 12 tests in 1 file/u);
});
