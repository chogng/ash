import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import config from '../playwright.config.ts';
import { playwrightTargetForProject } from '../test/automation/testTarget.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/frontend.yml'), 'utf8');
const testsWorkflow = readFileSync(resolve(repositoryRoot, '.github/workflows/frontend-tests.yml'), 'utf8');
const setupAction = readFileSync(resolve(repositoryRoot, '.github/actions/setup-frontend/action.yml'), 'utf8');

test('Frontend CI finishes main acceptance and cancels stale runs on other refs', () => {
	const concurrency = workflow.match(/^concurrency:\n((?:[ \t].*\n)+)/m)?.[1];
	assert.ok(concurrency, 'Frontend CI must retain its per-ref concurrency group');
	assert.match(concurrency, /^  group: frontend-\$\{\{ github\.ref \}\}$/m);
	assert.match(concurrency, /^  cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}$/m);
});

test('Frontend CI smoke commands select configured Playwright projects', () => {
	const names = new Set(config.projects?.map(project => project.name));
	const projects = [
		...testsWorkflow.matchAll(/pnpm exec playwright test[^\n]*--project=([\w-]+)/g),
		...testsWorkflow.matchAll(/node test\/smoke\/run\.ts ([\w-]+)/g),
	].map(match => match[1]);
	assert.ok(projects.length > 0, 'Frontend CI must retain explicit smoke project selections');
	for (const project of projects) {
		assert.ok(names.has(project), `Frontend CI references an unconfigured Playwright project: ${project}`);
		assert.doesNotThrow(() => playwrightTargetForProject(project));
	}
});

test('Frontend CI retains Academic coverage without rerunning the Workbench file', () => {
	const workbenchStep = testsWorkflow.match(/- name: Test Electron UI\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(workbenchStep, 'Frontend CI must retain the full Electron UI project');
	assert.match(workbenchStep, /pnpm run test:smoke:ui:no-compile --shard=/);
	const uiProject = config.projects?.find(project => project.name === 'electron-ui');
	assert.equal(uiProject?.testMatch, undefined, 'The UI suite must include every smoke file, including Academic Workbench');
	assert.deepEqual(uiProject?.testIgnore, ['**/release-package.spec.ts', '**/pdf-academic-corpus.spec.ts']);
	assert.deepEqual(playwrightTargetForProject('electron-ui'), { kind: 'electron', appServerMode: 'disabled' });

	const connectedStep = testsWorkflow.match(/- name: Test connected Academic document editing\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(connectedStep, 'Frontend CI must retain connected Academic document editing');
	assert.match(connectedStep, /if: matrix\.suite == 'connected' && matrix\.shard == 1/);
	assert.match(connectedStep, /node test\/smoke\/run\.ts electron-editor-app-server/);
	const editorProject = config.projects?.find(project => project.name === 'electron-editor-app-server');
	assert.deepEqual(editorProject?.testMatch, ['**/areas/editor/academic-open.spec.ts', '**/areas/editor/editor-open.spec.ts']);
	assert.deepEqual(playwrightTargetForProject('electron-editor-app-server'), { kind: 'electron', appServerMode: 'required' });
});

test('Frontend acceptance keeps existing names and requires every shard of its own surface', () => {
	for (const [job, name, shards, total] of [
		['browser', 'browser (ubuntu-24.04)', '[1]', 1],
		['electron-windows', 'electron (windows-latest)', '[1,2,3,4]', 4],
		['electron-macos', 'electron (macos-26)', '[1,2,3,4]', 4],
	] as const) {
		const suite = workflow.split(`  ${job}:\n`)[1]?.split(/^  [\w-]+:/m)[0];
		assert.ok(suite);
		assert.ok(suite.includes('uses: ./.github/workflows/frontend-tests.yml'));
		assert.ok(suite.includes(`shards: "${shards}"`));
		assert.ok(suite.includes(`shard-total: ${total}`));
		const gate = workflow.split(`  ${job}-check:\n`)[1]?.split(/^  [\w-]+:/m)[0];
		assert.ok(gate);
		assert.ok(gate.includes(`name: ${name}`));
		assert.ok(gate.includes(`needs: ${job}`));
		assert.ok(gate.includes(`RESULT: \${{ needs.${job}.result }}`));
		assert.ok(gate.includes('if: always()'));
		assert.ok(gate.includes('run: test "$RESULT" = success'));
	}
});

test('Frontend shards preserve serial UI workers and unique failure diagnostics', () => {
	assert.equal(config.workers, 1);
	assert.equal(config.fullyParallel, false);
	assert.match(testsWorkflow, /fail-fast: false/);
	assert.match(testsWorkflow, /suite: \[ui, connected\]/);
	assert.match(testsWorkflow, /if: matrix\.suite == 'ui'/);
	assert.match(testsWorkflow, /if: matrix\.suite == 'connected'/);
	assert.match(testsWorkflow, /shard: \$\{\{ fromJSON\(inputs.shards\) \}\}/);
	assert.match(testsWorkflow, /smoketest-no-compile --shard=\$\{\{ matrix.shard \}\}\/\$\{\{ inputs.shard-total \}\}/);
	assert.match(testsWorkflow, /name: frontend-\$\{\{ inputs.surface \}\}-\$\{\{ inputs.runner \}\}-\$\{\{ matrix.suite \}\}-\$\{\{ matrix.shard \}\}/);
	assert.match(setupAction, /save-if:.*github.ref == 'refs\/heads\/main'/);
	assert.match(setupAction, /shared-key: check/);
});

test('Frontend Electron shards consume one current-run build without rebuilding the App Server', () => {
	const builder = testsWorkflow.split('  prepare-electron:\n')[1]?.split(/^  [\w-]+:/m)[0];
	const shards = testsWorkflow.split('  test:\n')[1];
	assert.ok(builder);
	assert.ok(shards);
	assert.match(builder, /pnpm run pretest:smoke:ui/);
	assert.match(builder, /build\/desktop\/ci.py/);
	assert.match(builder, /if-no-files-found: error/);
	assert.match(shards, /needs: prepare-electron/);
	assert.match(shards, /build: "false"/);
	assert.match(shards, /actions\/download-artifact@/);
	assert.match(builder, /name: frontend-build-\$\{\{ inputs.runner \}\}/);
	assert.match(shards, /name: frontend-build-\$\{\{ inputs.runner \}\}/);
	assert.match(shards, /tar -xzf .build\/ci\/electron.tar.gz/);
	assert.match(shards, /pnpm run prepare:output/);
	assert.match(shards, /develop.py --select-prepared/);
	assert.doesNotMatch(shards, /pnpm run (?:prepare:backend|pretest:smoke|build\b)/);
	assert.doesNotMatch(shards, /pnpm run rebuild:/);
	const preparation = testsWorkflow.match(/- name: Prepare connected Electron smoke tests\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(preparation);
	assert.match(preparation, /run: pnpm run prepare:backend/);
	assert.doesNotMatch(preparation, /pretest:smoke:desktop/);
	const chromium = setupAction.match(/- name: Install Chromium\n([\s\S]*?)(?=\n    -)/)?.[1];
	assert.ok(chromium);
	assert.match(chromium, /playwright install --with-deps chromium/);
	assert.doesNotMatch(chromium, /if:/);
	assert.match(testsWorkflow, /pnpm test:unit --jobs 4/);
});

test('Frontend backend caching requires exact inputs and builds on a miss', () => {
	const builder = testsWorkflow.split('  prepare-electron:\n')[1]?.split(/^  [\w-]+:/m)[0];
	assert.ok(builder);
	assert.match(builder, /backend-cache: "true"/);
	const preparation = builder.match(/- name: Prepare connected Electron smoke tests\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(preparation);
	assert.match(preparation, /if: steps.setup.outputs.backend-cache-hit != 'true'/);
	assert.match(preparation, /pnpm run prepare:backend/);
	const selection = builder.match(/- name: Select cached Electron backend\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(selection);
	assert.match(selection, /if: steps.setup.outputs.backend-cache-hit == 'true'/);
	assert.match(selection, /develop.py --select-prepared/);
	const save = builder.match(/- name: Save prepared backend\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(save);
	assert.match(save, /if: github.ref == 'refs\/heads\/main' && steps.setup.outputs.backend-cache-hit != 'true'/);
	assert.match(save, /key: \$\{\{ steps.setup.outputs.backend-cache-key \}\}/);
	const restore = setupAction.match(/- name: Restore prepared backend\n([\s\S]*?)(?=\n    -)/)?.[1];
	assert.ok(restore);
	assert.match(restore, /key: \$\{\{ steps.backend-key.outputs.key \}\}/);
	assert.doesNotMatch(restore, /restore-keys:/);
	assert.ok(setupAction.indexOf('Extract prepared backend') < setupAction.indexOf('Cache App Server builds'));
	const cargo = setupAction.match(/- name: Cache App Server builds\n([\s\S]*?)(?=\n    -)/)?.[1];
	assert.ok(cargo);
	assert.match(cargo, /steps.backend.outputs.cache-hit != 'true'/);
});
