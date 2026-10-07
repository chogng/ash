import { expect, test } from "../../../automation/test.js";

test('Agent Sessions list opens inside Chat and closes with Escape in Web and Electron', async ({ driver, target, workbench }) => {
	test.skip(target.appServerMode !== "disabled", "The disconnected Code Workbench provides a deterministic Chat shell.");
	const page = workbench.page;
	if (!await page.locator(".ash-chat-view-pane").isVisible()) {
		await page.getByRole("button", { name: "Show Secondary Side Bar", exact: true }).click();
	}
	await expect(page.locator(".ash-chat-view-pane")).toBeVisible();

	const toggle = page.locator("[data-action-id='agentSessions.toggleAgentSessionsSidebar'] button");
	await expect(toggle).toBeVisible();
	await toggle.click();
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	await expect(sidebar).toBeVisible();
	const rows = sidebar.locator('.ash-agent-session-row');
	const count = await rows.count();
	await sidebar.getByRole('button', { name: 'New Session' }).click();
	await expect(rows).toHaveCount(count + 1);

	await driver.setWindowSize({ width: 680, height: 720 });
	await expect(page.locator('.ash-chat-body.compact.sessions-sidebar-visible')).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(sidebar).toBeHidden();
	await expect(toggle).toBeFocused();
});
