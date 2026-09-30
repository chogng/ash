import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-ui', 'Window restoration is a Desktop process lifecycle scenario.');
});

test('Desktop restores open Workbench and Agents windows and honors startup intent', async ({}, testInfo) => {
	test.setTimeout(120_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	const folder = testInfo.outputPath('folder');
	await mkdir(userDataDirectory, { recursive: true });
	await mkdir(folder, { recursive: true });
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory);
		const workbench = await application.firstWindow();
		await new Workbench(workbench).waitForReady();
		const opened = application.waitForEvent('window');
		await workbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		await application.close();
		application = undefined;

		const saved = JSON.parse(await readFile(join(userDataDirectory, 'state.json'), 'utf8')) as { windowSession: { active: number; windows: readonly { kind: string }[] } };
		expect(saved.windowSession.windows.map(window => window.kind)).toEqual(['workbench', 'sessions']);
		expect(saved.windowSession.active).toBe(1);

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(2);
		await expect(application.windows().find(page => page !== application!.windows()[0])!.locator('.ash-sessions-window')).toBeVisible();
		await application.windows()[0]!.close();
		await expect.poll(() => application!.windows().length).toBe(1);
		await application.close();
		application = undefined;
		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		await expect((await application.firstWindow()).locator('.ash-sessions-window')).toBeVisible();
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory, folder);
		await expect.poll(() => application!.windows().length).toBe(1);
		const targeted = await application.firstWindow();
		await new Workbench(targeted).waitForReady();
		await expect.poll(() => workspaceFolder(targeted)).toBe(folder);
		const reopenedAgents = application.waitForEvent('window');
		await targeted.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await reopenedAgents).locator('.ash-sessions-window')).toBeVisible();
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"one"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		const restoredAgents = await application.firstWindow();
		await expect(restoredAgents.locator('.ash-sessions-window')).toBeVisible();
		const returned = application.waitForEvent('window');
		await restoredAgents.evaluate(() => {
			const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			void bridge.invoke('ash:sessions:return-to-workbench');
		});
		await new Workbench(await returned).waitForReady();
		await expect.poll(() => application!.windows().length).toBe(1);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"none"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		const emptyWorkbench = await application.firstWindow();
		await new Workbench(emptyWorkbench).waitForReady();
		const preservedAgents = application.waitForEvent('window');
		await emptyWorkbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await preservedAgents).locator('.ash-sessions-window')).toBeVisible();
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"preserve"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory, folder);
		await expect.poll(() => application!.windows().length).toBe(3);
		await expect.poll(async () => {
			const windows = application!.windows();
			return (await Promise.all(windows.map(page => page.locator('.ash-sessions-window').count()))).reduce((sum, count) => sum + count, 0);
		}).toBe(1);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"folders"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		const folderWorkbench = await application.firstWindow();
		await new Workbench(folderWorkbench).waitForReady();
		await expect.poll(() => workspaceFolder(folderWorkbench)).toBe(folder);
	} finally {
		await application?.close();
	}
});

test('Workbench restores editor tabs unless editor restoration is disabled', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	const folder = testInfo.outputPath('folder');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await mkdir(folder, { recursive: true });
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory, folder);
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		await expect(page.locator('.ash-getting-started')).toBeVisible();
		await page.locator('[data-part="editor"] .ash-tab').hover();
		await page.locator('[data-part="editor"] .ash-tab-close-action button').click();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		await expect(page.locator('[data-part="editor"] .ash-tab')).toHaveCount(2);
		await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('editorparts.state')))).toBe(true);
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		const restored = await application.firstWindow();
		await new Workbench(restored).waitForReady();
		await expect(restored.locator('[data-part="editor"] .ash-tab')).toHaveCount(2);
		await expect(restored.locator('.ash-getting-started')).toHaveCount(0);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.startupEditor":"none","workbench.editor.restoreEditors":false}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		const disabled = await application.firstWindow();
		await new Workbench(disabled).waitForReady();
		await expect(disabled.locator('[data-part="editor"] .ash-tab')).toHaveCount(0);
		await disabled.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		const input = disabled.locator('[data-part="editor"] .stanza-editor-input');
		await input.focus();
		await input.type('unsaved after restart');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		const dirty = await application.firstWindow();
		await new Workbench(dirty).waitForReady();
		await expect(dirty.locator('[data-part="editor"] .ash-tab')).toHaveCount(1);
		await expect(dirty.locator('[data-part="editor"] .stanza-editor')).toContainText('unsaved after restart');
	} finally {
		await application?.close();
	}
});

test('Workbench reopens detached editor windows with their tabs', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.startupEditor":"none"}\n');
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory);
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		await expect(page.locator('.ash-tab')).toHaveCount(1);
		await page.keyboard.press('F1');
		const command = page.locator('.ash-quick-pick').getByRole('combobox');
		await command.fill('Move Editor into New Window');
		const opened = page.context().waitForEvent('page');
		await command.press('Enter');
		const detached = await opened;
		await expect(detached.locator('.ash-auxiliary-window-container .ash-tab')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('editorparts.state') && value.includes('Untitled-1')))).toBe(true);
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(2);
		const windows = application.windows();
		const reopened = windows.find(window => window !== windows[0] && !window.isClosed());
		await expect(reopened!.locator('.ash-auxiliary-window-container .ash-tab')).toHaveCount(1);
	} finally {
		await application?.close();
	}
});

test('updated version restores all windows once despite a none preference', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"none"}\n');
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory);
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		const version = await application.evaluate(({ app }) => app.getVersion());
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await opened).locator('.ash-sessions-window')).toBeVisible();
		await application.close();
		application = undefined;

		const statePath = join(userDataDirectory, 'state.json');
		const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
		await writeFile(statePath, JSON.stringify({ ...state, updateRestartVersion: version }));
		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(2);
		await expect.poll(async () => (JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>).updateRestartVersion).toBeUndefined();
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		await new Workbench(await application.firstWindow()).waitForReady();
	} finally {
		await application?.close();
	}
});

async function launch(userDataDirectory: string, folder?: string): Promise<ElectronApplication> {
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory, workspaceDirectory: folder });
	return _electron.launch({
		executablePath: configuration.executablePath,
		args: [...configuration.args],
		cwd: configuration.cwd,
		env: configuration.env,
		timeout: 30_000,
	});
}

async function workspaceFolder(page: Page): Promise<string | undefined> {
	const value = await page.evaluate(() => {
		const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return bridge.invoke('ash:workspace:context:read');
	});
	return parseWorkspace(value).folders[0]?.uri.fsPath;
}
