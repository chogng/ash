import { _electron, type ElectronApplication } from '@playwright/test';
import type { AppDetailsOptions, JumpListCategory, JumpListSettings, Task } from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';
import type { IConfigurationSnapshot } from '../../../../src/ash/platform/configuration/common/configurationIpc.js';
import { URI } from '../../../../src/ash/base/common/uri.js';

interface RecentProjectsProbe {
	categories: JumpListCategory[];
	settings: JumpListSettings;
	result: string;
	restore(): void;
}

interface TaskbarProbe {
	tasks: Task[];
	details: AppDetailsOptions[];
	accepted: boolean;
	restore(): void;
}

test.use({ openWorkspace: false });
test.beforeEach(({}, testInfo) => {
	test.skip(process.platform !== 'win32' || testInfo.project.name !== 'electron-ui', 'Windows taskbar integration requires the Windows Electron UI project.');
});

test('taskbar shortcuts use Ash identity, follow display language and launch real windows', async ({ application, workbench }) => {
	test.setTimeout(90_000);
	const electron = application as ElectronApplication;
	await electron.evaluate(({ app, BrowserWindow }) => {
		const originalTasks = app.setJumpList;
		const originalDetails = BrowserWindow.prototype.setAppDetails;
		const state = globalThis as typeof globalThis & { ashTaskbarProbe?: TaskbarProbe };
		const probe: TaskbarProbe = { tasks: [], details: [], accepted: false, restore: () => {
			app.setJumpList = originalTasks;
			BrowserWindow.prototype.setAppDetails = originalDetails;
			delete state.ashTaskbarProbe;
		} };
		state.ashTaskbarProbe = probe;
		app.setJumpList = categories => {
			probe.tasks = categories?.find(category => category.type === 'tasks')?.items?.map(item => ({ ...item, arguments: item.args! })) as Task[] ?? [];
			const result = originalTasks.call(app, categories);
			probe.accepted = result === 'ok';
			return result;
		};
		BrowserWindow.prototype.setAppDetails = function (details) { probe.details.push(details); originalDetails.call(this, details); };
	});
	const readTasks = (): Promise<Task[]> => electron.evaluate(() => (globalThis as typeof globalThis & { ashTaskbarProbe: TaskbarProbe }).ashTaskbarProbe.tasks);
	const setLanguage = async (locale: string): Promise<void> => {
		await workbench.page.evaluate(async locale => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as IConfigurationSnapshot;
			await ipc.invoke('ash:configuration:update', {
				expectedRevision: snapshot.revision,
				document: { version: 1, source: JSON.stringify({ ...JSON.parse(snapshot.document.source), 'workbench.locale': locale }) },
			});
		}, locale);
	};
	const runTask = async (task: Task): Promise<void> => {
		const home = await electron.evaluate(() => process.env.ASH_HOME);
		const environment: NodeJS.ProcessEnv = { ...process.env, ASH_HOME: home, ASH_DESKTOP_UI_ONLY: '1' };
		delete environment.ELECTRON_RUN_AS_NODE;
		const child = spawn(task.program, [task.arguments], { env: environment, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'ignore', 'pipe'] });
		let diagnostics = '';
		child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
		const [code] = await once(child, 'exit');
		expect(code, diagnostics).toBe(0);
	};
	try {
		await setLanguage('zh-cn');
		await expect.poll(async () => (await readTasks()).map(task => task.title)).toEqual(['新建窗口', '打开 Agents 窗口']);
		expect((await readTasks()).map(task => task.description)).toEqual(['打开新的 Ash 窗口', '打开 Ash Agents 窗口']);
		await setLanguage('en');
		await expect.poll(async () => (await readTasks()).map(task => task.title)).toEqual(['New Window', 'Open Agents Window']);
		expect(await electron.evaluate(() => (globalThis as typeof globalThis & { ashTaskbarProbe: TaskbarProbe }).ashTaskbarProbe.accepted)).toBe(true);
		const tasks = await readTasks();
		const identity = await electron.evaluate(({ app }) => ({ name: app.getName(), appPath: app.getAppPath(), userData: app.getPath('userData'), executable: process.execPath }));
		expect(identity.name).toBe('Ash');
		expect(tasks[0]!.program).toBe(identity.executable);
		expect(tasks[0]!.arguments).toContain(identity.appPath);
		expect(tasks[0]!.arguments).toContain(`--user-data-dir=${identity.userData}`);
		expect(tasks[0]!.iconPath).toBe(join(identity.appPath, '..', 'resources', 'win32', 'ash.ico'));
		const opened = electron.waitForEvent('window');
		await runTask(tasks[0]!);
		const newWindow = await opened;
		await new Workbench(newWindow).waitForReady();
		expect(electron.windows()).toHaveLength(2);
		const agentsOpened = electron.waitForEvent('window');
		await runTask(tasks[1]!);
		await expect((await agentsOpened).locator('.ash-sessions-window')).toBeVisible();
		await runTask(tasks[1]!);
		expect(electron.windows()).toHaveLength(3);
		const details = await electron.evaluate(() => (globalThis as typeof globalThis & { ashTaskbarProbe: TaskbarProbe }).ashTaskbarProbe.details);
		expect(details).toHaveLength(2);
		for (const detail of details) {
			expect(detail).toEqual({
				appId: 'com.ash.desktop', appIconPath: tasks[0]!.iconPath, appIconIndex: 0,
				relaunchDisplayName: 'Ash', relaunchCommand: `"${identity.executable}" ${tasks[0]!.arguments}`,
			});
		}
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashTaskbarProbe?: TaskbarProbe }).ashTaskbarProbe?.restore());
	}
});

test('taskbar projects share Welcome history and respect items removed in Windows', async ({ application, workbench }, testInfo) => {
	const electron = application as ElectronApplication;
	await electron.evaluate(({ app }) => {
		const originalList = app.setJumpList;
		const originalSettings = app.getJumpListSettings;
		const state = globalThis as typeof globalThis & { ashRecentProjectsProbe?: RecentProjectsProbe };
		const probe: RecentProjectsProbe = {
			categories: [], settings: { minItems: 2, removedItems: [] }, result: '',
			restore: () => { app.setJumpList = originalList; app.getJumpListSettings = originalSettings; delete state.ashRecentProjectsProbe; },
		};
		state.ashRecentProjectsProbe = probe;
		app.getJumpListSettings = () => probe.settings;
		app.setJumpList = categories => { probe.categories = categories ?? []; probe.result = originalList.call(app, categories); return probe.result as ReturnType<typeof app.setJumpList>; };
	});
	const folderUri = URI.file(testInfo.outputPath('folder with spaces')).toString();
	const workspaceUri = URI.file(testInfo.outputPath('team.code-workspace')).toString();
	const invoke = (channel: string, value?: unknown): Promise<unknown> => workbench.page.evaluate(async ({ channel, value }) => {
		return (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value?: unknown): Promise<unknown> } } }).ash.ipcRenderer.invoke(channel, value);
	}, { channel, value });
	const readCategories = (): Promise<JumpListCategory[]> => electron.evaluate(() => (globalThis as typeof globalThis & { ashRecentProjectsProbe: RecentProjectsProbe }).ashRecentProjectsProbe.categories);
	const projects = workbench.page.locator('.ash-getting-started-recent-name');
	try {
		await invoke('ash:workspaces:recent:add', { workspaces: [{ folderUri, label: 'Folder' }, { workspace: { id: 'team', configPath: workspaceUri }, label: 'Team' }] });
		await expect(projects).toHaveText(['Folder', 'Team']);
		await expect.poll(async () => (await readCategories()).find(category => category.type === 'custom')?.items?.map(item => item.title)).toEqual(['Folder', 'Team']);
		expect(await electron.evaluate(() => (globalThis as typeof globalThis & { ashRecentProjectsProbe: RecentProjectsProbe }).ashRecentProjectsProbe.result)).toBe('ok');
		const categories = await readCategories();
		expect(categories.map(category => category.type)).toEqual(['tasks', 'custom', 'recent']);
		expect(categories[1]!.items![0]!.args).toContain('--folder-uri');
		expect(categories[1]!.items![1]!.args).toContain('--workspace');
		await electron.evaluate(() => {
			const probe = (globalThis as typeof globalThis & { ashRecentProjectsProbe: RecentProjectsProbe }).ashRecentProjectsProbe;
			probe.settings.removedItems = [probe.categories.find(category => category.type === 'custom')!.items![0]!];
		});
		await invoke('ash:workspaces:recent:add', { workspaces: [{ workspace: { id: 'team', configPath: workspaceUri }, label: 'Team' }] });
		await expect(projects).toHaveText(['Team']);
		await expect.poll(async () => (await readCategories()).find(category => category.type === 'custom')?.items?.map(item => item.title)).toEqual(['Team']);
		await invoke('ash:workspaces:recent:clear');
		await expect(projects).toHaveCount(0);
		await expect.poll(async () => (await readCategories()).map(category => category.type)).toEqual(['tasks', 'recent']);
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashRecentProjectsProbe?: RecentProjectsProbe }).ashRecentProjectsProbe?.restore());
	}
});

test('Desktop imports existing Welcome projects once into the shared history', async ({ application, workbench }, testInfo) => {
	const folder = testInfo.outputPath('old folder');
	const workspace = testInfo.outputPath('old.code-workspace');
	const identity = { applicationId: 'code', scope: StorageScope.PROFILE, id: 'default' };
	await seedStorageOnNextLoad(application, workbench.page, identity, {
		'workbench.recentWorkspaces': { value: JSON.stringify([
			{ root: folder, name: 'Migrated Folder', lastOpened: 2 },
			{ root: workspace, name: 'Migrated Team', lastOpened: 1 },
		]), target: StorageTarget.USER },
	});
	await workbench.page.reload();
	await workbench.waitForReady();
	await expect(workbench.page.locator('.ash-getting-started-recent-name')).toHaveText(['Migrated Folder', 'Migrated Team']);
	await expect.poll(async () => (await readStorageEntries(application, workbench.page, identity))['workbench.recentWorkspaces']).toBeUndefined();
	await workbench.page.evaluate(async () => {
		await (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<void> } } }).ash.ipcRenderer.invoke('ash:workspaces:recent:clear');
	});
	await workbench.page.reload();
	await workbench.waitForReady();
	await expect(workbench.page.locator('.ash-getting-started-recent-name')).toHaveCount(0);
});

test('the Agents task starts the app directly in its Agents window', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('taskbar profile with spaces');
	await mkdir(userDataDirectory, { recursive: true });
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory, extraArgs: ['--agents-window'] });
	const application = await _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath, env: configuration.env });
	try {
		const page = await application.firstWindow();
		await expect(page.locator('.ash-sessions-window')).toBeVisible();
		expect(application.windows()).toHaveLength(1);
		const details = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), visible: window.isVisible() })));
		expect(details).toEqual([{ title: 'Ash Code Sessions', visible: true }]);
	} finally {
		await application.close();
	}
});
