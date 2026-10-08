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


for (const locale of ['en', 'zh-CN']) {
	test(`unsupported task configuration shows a clear error without starting a process and can be corrected (${locale})`, async ({ workbench, testWorkspace, restartWorkbench }) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench } = await restartWorkbench());
		}
		const initialTerminalCount = await workbench.terminal.instances.count();
		const unsupportedMessage = locale === 'zh-CN' ? /任务“Smoke configured”尚未启动，因为 Ash 尚不支持：/u : /Task 'Smoke configured' was not started because Ash does not yet support:/;
		const processMessage = locale === 'zh-CN' ? /任务“Smoke process”尚未启动，因为 Ash 尚不支持：type:process/u : /Task 'Smoke process' was not started because Ash does not yet support: type:process/;
		const configurationPath = join(testWorkspace.directory, '.vscode', 'tasks.json');
		await writeFile(configurationPath, JSON.stringify({
			version: '2.0.0', tasks: [
				{ label: 'Smoke configured', type: 'shell', command: 'node smoke-task.cjs', options: { cwd: '${workspaceFolder}/other', env: { MODE: 'test' } }, dependsOn: ['Compile'], problemMatcher: '$tsc', isBackground: true },
			]
		}));
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke configured');
		await expect(workbench.page.locator('.ash-notification-host').getByText(unsupportedMessage)).toBeVisible();
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
		await expect(workbench.page.locator('.ash-task-run')).toHaveCount(0);
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount);
		const tasksTab = workbench.page.getByRole('tab', { name: locale === 'zh-CN' ? '任务' : 'Tasks', exact: true });
		if (!await tasksTab.isVisible()) await workbench.quickaccess.runCommand('workbench.action.togglePanel');
		await tasksTab.click();
		await workbench.page.locator('.ash-tasks-run').filter({ hasText: 'Smoke configured' }).click();
		await expect(workbench.page.locator('.ash-tasks-status')).toContainText(unsupportedMessage);
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount);
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');

		await writeFile(configurationPath, JSON.stringify({
			version: '2.0.0', tasks: [
				{ label: 'Smoke process', type: 'process', command: 'node', args: ['smoke-task.cjs'] },
			]
		}));
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke process');
		await expect(workbench.page.locator('.ash-notification-host').getByText(processMessage)).toBeVisible();
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount);
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
		await tasksTab.click();
		await workbench.page.locator('.ash-tasks-run').filter({ hasText: 'Smoke process' }).click();
		await expect(workbench.page.locator('.ash-tasks-status')).toContainText(processMessage);
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount);
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');

		await writeFile(configurationPath, JSON.stringify({
			version: '2.0.0', tasks: [
				{ label: 'Smoke configured', type: 'shell', command: 'node smoke-task.cjs', customMetadata: { providerVersion: 2 }, problemMatcher: [] },
			]
		}));
		// The fixture also contributes four Cargo tasks; correcting this task must keep those siblings.
		// File changes must clear the prior error before the user retries.
		await expect(workbench.page.locator('.ash-tasks-run').filter({ hasText: 'Smoke configured' })).toBeVisible();
		await expect(workbench.page.locator('.ash-tasks-status')).toHaveText('5 workspace tasks.');
		await expect(workbench.page.locator('.ash-task-label')).toHaveText(['cargo build', 'cargo check', 'cargo test', 'cargo run', 'Smoke configured']);
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke configured');
		await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
		await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_1');
		await tasksTab.click();
		await expect(workbench.page.locator('.ash-tasks-status')).toHaveText('5 workspace tasks.');
		await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke configured — succeeded (0)');
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
	});
}
