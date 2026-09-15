import { expect, test } from "../../../automation/test.js";

test("Code opens Sessions in a dedicated Electron window and returns to Workbench", async ({ application, target, workbench }) => {
	test.skip(
		target.kind !== "electron" || target.workbenchMode !== "code",
		"This scenario verifies the Code Electron Sessions window.",
	);
	if (target.kind !== "electron") {
		return;
	}
	if (!("windows" in application)) {
		throw new Error("Dedicated Sessions window verification requires Electron");
	}

	const workbenchPage = workbench.page;
	const openSessions = workbenchPage.locator("[data-action-id='ash.code.open-sessions'] button");
	await expect(openSessions).toBeVisible();
	const sessionPagePromise = application.waitForEvent("window");
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await sessionsPage.waitForLoadState("domcontentloaded");
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='titlebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sessions']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeVisible();
	await expect(sessionsPage.locator(".ash-chat-input-part")).toBeVisible();
	await sessionsPage.locator(".ash-sessions-titlebar-new-session").click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(2);
	await expect(sessionsPage.locator(".ash-sessions-chat-slot.active")).toHaveCount(1);
	await sessionsPage.locator(".ash-sessions-chat-slot-close").last().click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(1);
	await expect.poll(() => application.windows().length).toBe(2);

	const sessionWindowState = await application.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		return windows.map((window: { readonly id: number; getTitle(): string; readonly webContents: { getURL(): string } }) => ({
			id: window.id,
			title: window.getTitle(),
			url: window.webContents.getURL(),
		}));
	});
	expect(sessionWindowState).toHaveLength(2);
	expect(sessionWindowState.some((window: { readonly url: string }) => window.url.includes("sessions-code.html"))).toBe(true);

	const closed = sessionsPage.waitForEvent("close");
	await sessionsPage.getByRole("button", { name: "Workbench" }).click();
	await closed;
	await expect.poll(() => application.windows().length).toBe(1);
	await expect(workbenchPage.locator(".ash-workbench")).toBeVisible();
});
