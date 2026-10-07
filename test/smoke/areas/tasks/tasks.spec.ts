import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires workspace tasks and terminal execution.');
	await mkdir(join(testWorkspace.directory, '.vscode'));
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Smoke build', type: 'shell', command: 'node smoke-task.cjs', group: 'build' },
			{ label: 'Smoke watch', type: 'shell', command: 'node smoke-watch.cjs' },
		]
	}));
	await writeFile(join(testWorkspace.directory, 'task-runs.txt'), '0');
	await writeFile(join(testWorkspace.directory, 'smoke-task.cjs'), "const fs = require('node:fs'); const count = Number(fs.readFileSync('task-runs.txt', 'utf8')) + 1; fs.writeFileSync('task-runs.txt', String(count)); console.log('ASH_TASK_RUN_' + count);\n");
	await writeFile(join(testWorkspace.directory, 'smoke-watch.cjs'), "console.log('ASH_TASK_WATCH_READY'); setInterval(() => {}, 1000);\n");
});

test('task discovery does not execute commands and explicit run and rerun use the workspace terminal', async ({ workbench, testWorkspace }) => {
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(workbench.quickaccess.items.filter({ hasText: 'Smoke build' })).toBeVisible();
	expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
	await workbench.quickaccess.select('Smoke build');
	await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_1');
	await workbench.quickaccess.runCommand('workbench.action.tasks.reRunTask');
	await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('2');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_2');
	await workbench.page.getByRole('tab', { name: 'Tasks', exact: true }).click();
	await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke build — succeeded (0)');
});

test('terminating a running workspace task stops its terminal and records cancellation', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Smoke watch');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_WATCH_READY');
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	await workbench.page.getByRole('tab', { name: 'Tasks', exact: true }).click();
	await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke watch — canceled');
});
