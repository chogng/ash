import type { ElectronApplication, Page } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { parseWorkspace } from "../../../../src/ash/platform/workspace/common/workspace.js";
import { expect, test } from "../../../automation/test.js";
import { createTestWorkspace, disposeTestWorkspace, type TestWorkspace } from "../../../automation/testWorkspace.js";
import { Workbench } from "../../../automation/workbench.js";

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

		await workbench.page.evaluate(() => { document.title = "multi-workbench:first"; });
		await secondPage.evaluate(() => { document.title = "multi-workbench:second"; });
		await emitSecondInstance(application, testWorkspace.directory);

		await expect.poll(() => application.windows().length).toBe(2);
		await expect.poll(() => focusedWindowTitle(application)).toBe("multi-workbench:first");

		const closed = secondPage.waitForEvent("close");
		await secondPage.close();
		await closed;
		await expect.poll(() => application.windows().length).toBe(1);
		await expect(workbench.element).toBeVisible();
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
