import type { ElectronApplication, Page } from "@playwright/test";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from 'node:path';
import { parseWorkspace } from "../../../../src/ash/platform/workspace/common/workspace.js";
import { expect, test } from "../../../automation/test.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "../../../automation/testWorkspace.js";
import { Workbench } from "../../../automation/workbench.js";

import { waitForElectronWindowState } from "../../../automation/electronDriver.js";

const workspacesToDispose: TestWorkspace[] = [];
test.afterAll(async () => {
	for (const workspace of workspacesToDispose) await disposeTestWorkspace(workspace);
});

test("a second instance opens an independent Workbench and reuses an existing Workspace window", async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== "electron", "This scenario verifies the Electron Workbench window registry.");
	if (target.kind !== "electron" || !("windows" in application)) return;

	const secondWorkspace = await createTestWorkspace();
	workspacesToDispose.push(secondWorkspace);
	let secondPage: Page | undefined;
	try {
		const secondPagePromise = application.waitForEvent("window");
		await emitSecondInstance(application, secondWorkspace.directory);
		secondPage = await secondPagePromise;
		if (target.appServerMode === 'required') {
			await secondPage.getByRole('dialog', { name: 'Ash' }).getByRole('button', { name: 'Trust Folder & Enable Features' }).click();
		}
		const secondWorkbench = new Workbench(secondPage);
		await secondWorkbench.waitForReady();

		await expect.poll(() => application.windows().length).toBe(2);
		expect(await canonicalWorkspacePath(workbench.page)).toBe(await realpath(testWorkspace.directory));
		expect(await canonicalWorkspacePath(secondPage)).toBe(await realpath(secondWorkspace.directory));
		await secondPage.bringToFront();
		const sidebar = secondPage.getByRole('region', { name: 'Primary sidebar', exact: true });
		const sidebarWasVisible = await sidebar.isVisible();
		await secondWorkbench.quickaccess.runCommand('workbench.action.toggleSideBar');
		await expect(sidebar).toBeVisible({ visible: !sidebarWasVisible });
		const workspaceId = await secondPage.evaluate(async () => {
			const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ id: string }> } } }).ash;
			return (await bridge.ipcRenderer.invoke('ash:workspace:context:read')).id;
		});

		await workbench.page.evaluate(() => { document.title = "multi-workbench:first"; });
		await secondPage.evaluate(() => { document.title = "multi-workbench:second"; });
		await emitSecondInstance(application, testWorkspace.directory);

		await expect.poll(() => application.windows().length).toBe(2);
		await expect.poll(() => focusedWindowTitle(application)).toBe("multi-workbench:first");

		const closed = secondPage.waitForEvent("close");
		const closingWindowId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'multi-workbench:second')!.id);
		await expect.poll(() => readWindowLogs(application, closingWindowId)).toContainEqual(expect.objectContaining({ source: `window-${closingWindowId}`, category: 'lifecycle', message: 'Workbench restored' }));
		await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), closingWindowId);
		await closed;
		secondPage = undefined;
		await expect.poll(() => application.windows().length).toBe(1);
		await expect(workbench.element).toBeVisible();
		const userData = await application.evaluate(({ app }) => app.getPath('userData'));
		const durableState = JSON.parse(await readFile(join(userData, 'workbench-state.json'), 'utf8')) as { storages: { identity: { id: string; scope: string }; entries: Record<string, { value: string }> }[] };
		expect(durableState.storages.find(scope => scope.identity.scope === 'workspace' && scope.identity.id === workspaceId)?.entries['workbench.layout.sidebar.visible']?.value).toBe(String(!sidebarWasVisible));
		const reopening = application.waitForEvent('window');
		await emitSecondInstance(application, secondWorkspace.directory);
		secondPage = await reopening;
		await new Workbench(secondPage).waitForReady();
		await expect(secondPage.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeVisible({ visible: !sidebarWasVisible });
	} finally {
		if (secondPage && !secondPage.isClosed()) await secondPage.close().catch(() => undefined);
	}
});

test('Open in Agents reuses one window across Workbench workspaces', async ({ application, target, workbench, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires Code Electron');
	if (target.kind !== 'electron' || !('windows' in application)) return;

	const secondWorkspace = await createTestWorkspace();
	workspacesToDispose.push(secondWorkspace);
	let secondPage: Page | undefined;
	try {
		const secondPagePromise = application.waitForEvent('window');
		await emitSecondInstance(application, secondWorkspace.directory);
		secondPage = await secondPagePromise;
		if (target.appServerMode === 'required') {
			await secondPage.getByRole('dialog', { name: 'Ash' }).getByRole('button', { name: 'Trust Folder & Enable Features' }).click();
		}
		await new Workbench(secondPage).waitForReady();

		const agentsPagePromise = application.waitForEvent('window');
		await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agentsPage = await agentsPagePromise;
		await expect(agentsPage.locator('.ash-code-sessions-window')).toBeVisible();
		const initialConnection = await agentsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ generation: number }> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:remote:connection');
		});
		const agentsWindow = await application.browserWindow(agentsPage);
		const agentsWindowId = await agentsWindow.evaluate(window => window.id);
		// Renderer restoration and the OS focus transition complete independently.
		await waitForElectronWindowState(application, agentsPage, { focused: true });
		await expect.poll(() => readWindowLogs(application, agentsWindowId!)).toContainEqual(expect.objectContaining({ source: `window-${agentsWindowId}`, category: 'lifecycle', message: 'Agents restored' }));
		await secondPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<void> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:native-host:open-agents-window');
		});

		await waitForElectronWindowState(application, agentsPage, { focused: true });
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes('sessions-code.html')).length)).toBe(1);
		await expect.poll(() => application.windows().length).toBe(3);
		await expect.poll(() => canonicalWorkspacePath(agentsPage)).toBe(await realpath(secondWorkspace.directory));
		await expect(agentsPage.locator('.ash-code-sessions-window')).toBeVisible();
		if (target.appServerMode === 'required') {
			const reusedConnection = await agentsPage.evaluate(async () => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ generation: number }> } } }).ash.ipcRenderer;
				return ipc.invoke('ash:remote:connection');
			});
			expect(reusedConnection.generation).toBe(initialConnection.generation);
		}
	} finally {
		if (secondPage && !secondPage.isClosed()) await secondPage.close().catch(() => undefined);
	}
});

test('dirty editor content survives an immediate Electron window close', async ({ application, target }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code Electron Workbench and App Server');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const workspace = await createTestWorkspace();
	workspacesToDispose.push(workspace);
	let secondPage: Page | undefined;
	try {
		const opened = application.waitForEvent('window');
		await emitSecondInstance(application, workspace.directory);
		secondPage = await opened;
		await secondPage.getByRole('dialog', { name: 'Ash' }).getByRole('button', { name: 'Trust Folder & Enable Features' }).click();
		const secondWorkbench = new Workbench(secondPage);
		await secondWorkbench.waitForReady();
		await secondPage.bringToFront();
		const windowId = await secondPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const windows = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { id: number; focused: boolean }[];
			const focused = windows.find(window => window.focused);
			if (!focused) throw new Error('Second Workbench is not focused');
			return focused.id;
		});
		const fileRow = secondPage.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
		await expect(fileRow).toHaveCount(1);
		const showSidebar = secondPage.getByRole('button', { name: 'Show Primary Side Bar' });
		if (await showSidebar.isVisible()) await showSidebar.click();
		await fileRow.click();
		const input = secondWorkbench.editors.groupAt(0).content.locator('.stanza-editor-input');
		await input.focus();
		await input.press('ControlOrMeta+A');
		await input.type('preserved by close handshake');
		const closed = secondPage.waitForEvent('close');
		await application.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.close(); }, windowId);
		await closed;
		secondPage = undefined;
		const reopened = application.waitForEvent('window');
		await emitSecondInstance(application, workspace.directory);
		secondPage = await reopened;
		await new Workbench(secondPage).waitForReady();
		await expect(secondPage.locator('.stanza-editor-line-text').first()).toContainText('preserved by close handshake');
	} finally {
		if (secondPage && !secondPage.isClosed()) await secondPage.close().catch(() => undefined);
	}
});

async function emitSecondInstance(application: ElectronApplication, workspaceDirectory: string): Promise<void> {
	await application.evaluate(({ app }, directory) => {
		app.emit("second-instance", {} as never, [process.execPath, app.getAppPath(), "--folder", directory], process.cwd(), {});
	}, workspaceDirectory);
}

async function canonicalWorkspacePath(page: Page): Promise<string> {
	const value = await page.evaluate(async () => {
		const bridge = (globalThis as unknown as { ash?: { ipcRenderer?: { invoke(channel: string): Promise<unknown> } } }).ash?.ipcRenderer;
		if (!bridge) throw new Error("Ash renderer IPC bridge is unavailable");
		return bridge.invoke("ash:workspace:context:read");
	});
	const workspace = parseWorkspace(value);
	expect(workspace.folders).toHaveLength(1);
	return realpath(workspace.folders[0]!.uri.fsPath);
}

async function focusedWindowTitle(application: ElectronApplication): Promise<string | undefined> {
	return application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle());
}

async function readWindowLogs(application: ElectronApplication, windowId: number): Promise<readonly unknown[]> {
	const root = await application.evaluate(({ app }) => app.getPath('logs'));
	const session = (await readdir(root)).find(name => /^\d{8}T\d{9}-[\da-f-]{36}$/.test(name));
	if (!session) { return []; }
	const directory = join(root, session);
	const file = `window-${windowId}.log`;
	if (!(await readdir(directory)).includes(file)) { return []; }
	return (await readFile(join(directory, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
