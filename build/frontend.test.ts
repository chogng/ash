import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import config from '../playwright.config.ts';
import { playwrightTargetForProject } from '../test/automation/testTarget.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/frontend.yml'), 'utf8');

test('Frontend CI finishes main acceptance and cancels stale runs on other refs', () => {
	const concurrency = workflow.match(/^concurrency:\n((?:[ \t].*\n)+)/m)?.[1];
	assert.ok(concurrency, 'Frontend CI must retain its per-ref concurrency group');
	assert.match(concurrency, /^  group: frontend-\$\{\{ github\.ref \}\}$/m);
	assert.match(concurrency, /^  cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}$/m);
});

test('Frontend CI smoke commands select configured Playwright projects', () => {
	const names = new Set(config.projects?.map(project => project.name));
	const projects = [
		...workflow.matchAll(/pnpm exec playwright test[^\n]*--project=([\w-]+)/g),
		...workflow.matchAll(/node test\/smoke\/run\.ts ([\w-]+)/g),
	].map(match => match[1]);
	assert.ok(projects.length > 0, 'Frontend CI must retain explicit smoke project selections');
	for (const project of projects) {
		assert.ok(names.has(project), `Frontend CI references an unconfigured Playwright project: ${project}`);
		assert.doesNotThrow(() => playwrightTargetForProject(project));
	}
});

test('Frontend CI retains Academic coverage in the unified Workbench projects', () => {
	const workbenchStep = workflow.match(/- name: Test Academic workbench\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(workbenchStep, 'Frontend CI must retain the Academic Workbench step');
	assert.match(workbenchStep, /if: matrix\.surface == 'electron'/);
	assert.match(workbenchStep, /playwright test test\/smoke\/areas\/academic\/academic-workbench\.spec\.ts --project=electron-ui/);
	assert.deepEqual(playwrightTargetForProject('electron-ui'), { kind: 'electron', appServerMode: 'disabled' });

	const connectedStep = workflow.match(/- name: Test connected Academic document editing\n([\s\S]*?)(?=\n      -)/)?.[1];
	assert.ok(connectedStep, 'Frontend CI must retain connected Academic document editing');
	assert.match(connectedStep, /node test\/smoke\/run\.ts electron-editor-app-server/);
	const editorProject = config.projects?.find(project => project.name === 'electron-editor-app-server');
	assert.deepEqual(editorProject?.testMatch, ['**/areas/editor/academic-open.spec.ts', '**/areas/editor/editor-open.spec.ts']);
	assert.deepEqual(playwrightTargetForProject('electron-editor-app-server'), { kind: 'electron', appServerMode: 'required' });
});
