import type { ElectronApplication, Page } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { parseWorkspace } from "../../../../src/ash/platform/workspace/common/workspace.js";
import { expect, test } from "../../../automation/test.js";
import { createTestWorkspace, disposeTestWorkspace } from "../../../automation/testWorkspace.js";
import { Workbench } from "../../../automation/workbench.js";

test("a second instance opens an independent Workbench and reuses an existing Workspace window", async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== "electron", "This scenario verifies the Electron Workbench window registry.");
	if (target.kind !== "electron" || !("windows" in application)) return;

	const secondWorkspace = await createTestWorkspace();
	let secondPage: Page | undefined;
	try {
		const secondPagePromise = application.waitForEvent("window");
		await emitSecondInstance(application, secondWorkspace.directory);
		secondPage = await secondPagePromise;
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
		await disposeTestWorkspace(secondWorkspace);
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
