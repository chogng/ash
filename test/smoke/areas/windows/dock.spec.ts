import type { ElectronApplication } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { URI } from '../../../../src/ash/base/common/uri.js';

test.use({ openWorkspace: false });

for (const [locale, label] of [['en', 'New Window'], ['zh-CN', '新建窗口']] as const) {
	test.describe(`Dock menu in ${locale}`, () => {
		test.use({ electronUserSettings: { 'workbench.locale': locale } });
		test('Dock New Window uses the display language and opens an additional empty Workbench', { tag: ['@electron-ui', '@darwin'] }, async ({ application }) => {
			const electron = application as ElectronApplication;
			await expect.poll(() => electron.evaluate(({ app }) => app.dock?.getMenu()?.items.map(item => item.label))).toEqual([label]);
			await electron.evaluate(({ app }) => app.dock!.getMenu()!.items[0]!.click());
			await expect.poll(() => electron.windows().length).toBe(2);
			await expect(electron.windows()[1]!.locator('.ash-workbench')).toBeVisible();
		});
	});
}

interface DockRecentDocumentsProbe {
	paths: string[];
	restore(): void;
}

test('Dock recent projects filter missing paths, follow shared history and restore after restart', { tag: ['@electron-ui', '@darwin'] }, async ({ application, workbench, reloadWorkbench }, testInfo) => {
	let electron = application as ElectronApplication;
	const folders = Array.from({ length: 8 }, (_, index) => testInfo.outputPath(`project ${index}`));
	await Promise.all(folders.map(folder => mkdir(folder, { recursive: true })));
	const workspace = testInfo.outputPath('team.code-workspace');
	await writeFile(workspace, JSON.stringify({ folders: [{ path: folders[0] }] }));
	const missing = testInfo.outputPath('missing project');
	const recents = [
		{ folderUri: URI.file(missing).toString() },
		{ workspace: { id: 'team', configPath: URI.file(workspace).toString() } },
		...folders.map(folder => ({ folderUri: URI.file(folder).toString() })),
	];
	const callHistory = (command: string, arg?: unknown): Promise<unknown> => workbench.page.evaluate(({ command, arg }) => globalThis.ashTestMainProcess.call('workspaces', command, arg), { command, arg });
	const readDocuments = (): Promise<string[]> => electron.evaluate(({ app }) => app.getRecentDocuments());
	await electron.evaluate(({ app }) => {
		const add = app.addRecentDocument;
		const clear = app.clearRecentDocuments;
		const state = globalThis as typeof globalThis & { ashDockRecentsProbe?: DockRecentDocumentsProbe; };
		const probe: DockRecentDocumentsProbe = {
			paths: [],
			restore: () => { app.addRecentDocument = add; app.clearRecentDocuments = clear; delete state.ashDockRecentsProbe; },
		};
		state.ashDockRecentsProbe = probe;
		app.addRecentDocument = path => { probe.paths.push(path); add.call(app, path); };
		app.clearRecentDocuments = () => { probe.paths = []; clear.call(app); };
	});
	const readAddedPaths = (): Promise<string[]> => electron.evaluate(() => (globalThis as typeof globalThis & { ashDockRecentsProbe: DockRecentDocumentsProbe; }).ashDockRecentsProbe.paths);
	try {
		await callHistory('clearRecentlyOpened');
		await callHistory('addRecentlyOpened', { workspaces: recents });
		await expect.poll(readAddedPaths).toEqual([workspace, ...folders.slice(0, 6)].reverse());
		await callHistory('removeRecentlyOpened', [URI.file(workspace).toString()]);
		await expect.poll(readAddedPaths).toEqual(folders.slice(0, 7).reverse());
		await rm(folders[0]!, { recursive: true });
		await callHistory('addRecentlyOpened', { workspaces: [{ folderUri: URI.file(missing).toString() }] });
		await expect.poll(readAddedPaths).toEqual(folders.slice(1).reverse());
		const savedHistory = await callHistory('getRecentlyOpened');
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashDockRecentsProbe: DockRecentDocumentsProbe; }).ashDockRecentsProbe.restore());
		// Seed an obsolete system entry to prove startup replaces the OS list from shared history.
		await electron.evaluate(({ app }, path) => app.addRecentDocument(path), workspace);
		await expect.poll(readDocuments).toContain(workspace);
		({ application, workbench } = await reloadWorkbench());
		electron = application as ElectronApplication;
		expect(await callHistory('getRecentlyOpened')).toEqual(savedHistory);
		await expect.poll(readDocuments).toContain(folders[1]);
		await expect.poll(readDocuments).not.toContain(workspace);
		const restored = await readDocuments();
		// macOS applies the user's recent-item limit independently of the seven submitted projects.
		expect(restored.length).toBeLessThanOrEqual(7);
		expect(restored.every(path => folders.slice(1).includes(path))).toBe(true);
		await callHistory('clearRecentlyOpened');
		await expect.poll(readDocuments).toEqual([]);
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashDockRecentsProbe?: DockRecentDocumentsProbe; }).ashDockRecentsProbe?.restore());
	}
});

test('Dock open-file events open folders and workspace files through the launch service', { tag: ['@electron-ui', '@darwin'] }, async ({ application, workbench }, testInfo) => {
	const electron = application as ElectronApplication;
	const folder = testInfo.outputPath('folder with spaces');
	await mkdir(folder, { recursive: true });
	const workspace = testInfo.outputPath('team.code-workspace');
	await writeFile(workspace, JSON.stringify({ folders: [{ path: folder }] }));
	for (const path of [folder, workspace]) {
		await electron.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() { } }, file), path);
		await expect.poll(async () => {
			const contexts = await Promise.all(electron.windows().map(page => page.evaluate(async () => {
				const ipc = (globalThis as unknown as { ash?: { ipcRenderer: { invoke(channel: string): Promise<{ folders: { uri: string; }[]; }>; }; }; }).ash?.ipcRenderer;
				return ipc ? (await ipc.invoke('ash:workspace:context:read')).folders.map(folder => folder.uri) : [];
			}).catch(() => [])));
			return contexts.flat();
		}).toContain(URI.file(folder).toString());
		await expect.poll(() => workbench.page.evaluate(async () => {
			const recents = await globalThis.ashTestMainProcess.call('workspaces', 'getRecentlyOpened') as { workspaces: { folderUri?: string; workspace?: { configPath: string; }; }[]; };
			return recents.workspaces.map(recent => recent.folderUri ?? recent.workspace?.configPath);
		})).toContain(URI.file(path).toString());
	}
});
