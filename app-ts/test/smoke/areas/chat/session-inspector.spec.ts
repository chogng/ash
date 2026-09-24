import { expect, test } from "../../../automation/test.js";

test("Chat Session Inspector is a keyboard-closeable drawer in Web and Electron", async ({ driver, target, workbench }) => {
	test.skip(target.workbenchMode !== "code" || target.appServerMode !== "disabled", "The disconnected Code Workbench provides a deterministic Chat shell.");
	const page = workbench.page;
	if (!await page.locator(".ash-chat-view-pane").isVisible()) {
		await page.getByRole("button", { name: "Show Secondary Side Bar", exact: true }).click();
	}
	await expect(page.locator(".ash-chat-view-pane")).toBeVisible();

	const toggle = page.locator("[data-action-id='workbench.action.chat.toggleSessionInspector'] button");
	await expect(toggle).toBeVisible();
	await toggle.click();
	const inspector = page.locator(".ash-session-inspector");
	await expect(inspector).toBeVisible();

	await driver.setWindowSize({ width: 680, height: 720 });
	await expect(page.locator(".ash-chat-body.compact.inspector-visible")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(inspector).toBeHidden();
	await expect(toggle).toBeFocused();
});
