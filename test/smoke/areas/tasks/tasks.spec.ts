import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

// Windows' default cmd shell does not receive the POSIX exit wrapper. Return the
// fixture process's actual exit code so every platform verifies success.
const buildCommand = process.platform === 'win32' ? 'node smoke-task.cjs & exit' : 'node smoke-task.cjs';

test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires workspace tasks and terminal execution.');
	await mkdir(join(testWorkspace.directory, '.vscode'));
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Smoke build', type: 'shell', command: buildCommand, group: 'build' },
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

test('workspace task progress signals play the bundled sound, reload policy, and stop on cancellation', async ({ workbench }) => {
	test.setTimeout(90_000);
	const page = workbench.page;
	const audioState = { attempts: 0, played: 0, announcements: 0, audio: undefined as HTMLMediaElement | undefined };
	await page.evaluate(() => {
		const state = { attempts: 0, played: 0, announcements: 0, audio: undefined as HTMLMediaElement | undefined };
		const original = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = async function (): Promise<void> {
			state.audio = this;
			state.attempts++;
			await original.call(this);
			state.played++;
		};
		const observer = new MutationObserver(() => {
			if ([...document.querySelectorAll('.ash-aria-status')].some(region => region.textContent === 'Progress')) { state.announcements++; }
		});
		observer.observe(document.querySelector('.ash-aria-live')!, { subtree: true, childList: true });
		Object.assign(window, { ashTestProgressAudio: state, ashTestProgressObserver: observer, ashTestProgressOriginalPlay: original });
	});
	const readAudio = () => page.evaluate(() => {
		const state = (window as unknown as { ashTestProgressAudio: typeof audioState; }).ashTestProgressAudio;
		return { attempts: state.attempts, played: state.played, announcements: state.announcements, volume: state.audio?.volume, duration: state.audio?.duration, error: state.audio?.error?.code, paused: state.audio?.paused };
	});
	try {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('general');
		await workbench.settingsEditor.selectCategory('general');
		const settings = workbench.settingsEditor.element;
		const progress = settings.locator('[data-configuration-key="accessibility.signals.progress"]');
		const sound = progress.getByRole('textbox', { name: 'Mode 1', exact: true });
		const announcement = progress.getByRole('textbox', { name: 'Mode 2', exact: true });
		await expect(sound).toHaveValue('auto');
		await expect(announcement).toHaveValue('off');
		await sound.fill('on');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
		await announcement.fill('auto');
		await announcement.press('Tab');
		await expect(announcement).toBeEnabled();
		const reader = settings.locator('[data-configuration-key="editor.accessibilitySupport"]').getByRole('combobox');
		await reader.click();
		await page.getByRole('option', { name: 'On', exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();

		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke watch');
		await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_WATCH_READY');
		await expect.poll(async () => (await readAudio()).played).toBeGreaterThan(0);
		await expect.poll(async () => (await readAudio()).announcements).toBeGreaterThan(0);
		const first = await readAudio();
		expect(first).toMatchObject({ volume: 0.7, error: undefined });
		expect(first.duration).toBeGreaterThan(0);

		await workbench.settingsEditor.openUserSettingsUI();
		await sound.fill('off');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
		const volume = settings.locator('[data-configuration-key="accessibility.signalOptions.volume"]');
		await volume.fill('25');
		await volume.press('Tab');
		await expect.poll(async () => (await readAudio()).volume).toBe(0.25);
		await settings.locator('.ash-modal-editor-close').click();
		const disabled = await readAudio();
		// Observe a full cue interval to prove policy reload suppresses playback during the same task.
		await page.waitForTimeout(5500);
		expect((await readAudio()).attempts).toBe(disabled.attempts);
		await workbench.settingsEditor.openUserSettingsUI();
		await sound.fill('on');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
		await settings.locator('.ash-modal-editor-close').click();
		await expect.poll(async () => (await readAudio()).played).toBeGreaterThan(disabled.played);
		await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
		await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
		await expect(page.locator('.ash-task-run')).toContainText('Smoke watch — canceled');
		await expect.poll(async () => (await readAudio()).paused).toBe(true);
		const stopped = await readAudio();
		await page.waitForTimeout(5500);
		expect(await readAudio()).toEqual(stopped);
	} finally {
		await page.evaluate(() => {
			const state = window as unknown as { ashTestProgressObserver: MutationObserver; ashTestProgressOriginalPlay: typeof HTMLMediaElement.prototype.play; };
			state.ashTestProgressObserver.disconnect();
			HTMLMediaElement.prototype.play = state.ashTestProgressOriginalPlay;
		});
	}
});


test('task outcome signals play once for success or failure without duplicating terminal results', async ({ workbench, testWorkspace }) => {
	test.setTimeout(60_000);
	await writeFile(join(testWorkspace.directory, 'smoke-fail.cjs'), 'process.exit(7);\n');
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Smoke build', type: 'shell', command: 'node smoke-task.cjs' },
			{ label: 'Smoke fail', type: 'shell', command: 'node smoke-fail.cjs' },
		]
	}));
	const page = workbench.page;
	const assets = Object.fromEntries(await Promise.all(['success', 'error'].map(async name => [(await readFile(join(process.cwd(), 'src/ash/platform/accessibilitySignal/browser/media', `${name}.mp3`))).toString('base64'), name])));
	await page.evaluate(assets => {
		const cues: { name: string; duration?: number; }[] = [];
		const original = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = async function (): Promise<void> {
			const bytes = new Uint8Array(await (await fetch(this.src)).arrayBuffer());
			const cue = { name: assets[btoa(String.fromCharCode(...bytes))], duration: undefined as number | undefined };
			cues.push(cue);
			await original.call(this);
			cue.duration = this.duration;
		};
		Object.assign(window, { ashTestOutcomeCues: cues, ashTestOutcomePlay: original });
	}, assets);
	const readCues = () => page.evaluate(() => (window as unknown as { ashTestOutcomeCues: { name: string; duration?: number; }[]; }).ashTestOutcomeCues);
	try {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('general');
		await workbench.settingsEditor.selectCategory('general');
		for (const name of ['taskCompleted', 'taskFailed', 'terminalCommandSucceeded', 'terminalCommandFailed']) {
			const sound = workbench.settingsEditor.element.locator(`[data-configuration-key="accessibility.signals.${name}"]`).getByRole('textbox', { name: 'Mode 1', exact: true });
			await sound.fill('on');
			await sound.press('Tab');
			await expect(sound).toBeEnabled();
		}
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke build');
		await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
		await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).length).toBe(1);
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke fail');
		await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
		await expect(page.locator('.ash-task-run').filter({ hasText: 'Smoke fail' })).toContainText('Smoke fail — failed (7)');
		await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).length).toBe(2);
		const cues = await readCues();
		expect(cues.map(cue => cue.name)).toEqual(['success', 'error']);
		expect(cues.every(cue => cue.duration! > 0)).toBe(true);
	} finally {
		await page.evaluate(() => { HTMLMediaElement.prototype.play = (window as unknown as { ashTestOutcomePlay: typeof HTMLMediaElement.prototype.play; }).ashTestOutcomePlay; });
	}
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
				{ label: 'Smoke configured', type: 'shell', command: buildCommand, customMetadata: { providerVersion: 2 }, problemMatcher: [] },
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
