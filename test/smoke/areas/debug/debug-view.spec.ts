import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Run and Debug opens a welcome pane in an empty window', async ({ workbench, runningApplication }) => {
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-container-id="ash.debug"]');
	await expect(pane.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['Run']);
	await expect(pane.getByRole('button', { name: 'Open Folder', exact: true })).toBeVisible();
	await expect(
		page.locator('[data-part="sidebar"]').getByRole('button', { name: /^Debug configuration:/ }),
	).toHaveCount(0);
	await expect(
		pane.locator('.ash-debug-variables, .ash-debug-watch, .ash-debug-stack, .ash-debug-empty'),
	).toHaveCount(0);
	const welcome = pane.locator('[data-view-id="workbench.debug.welcome"]');
	await expect(welcome).toBeVisible();
	// A single registered view shares the Part title and leaves its content reachable.
	await expect(welcome.getByRole('button', { name: 'Run', exact: true })).toBeHidden();
	const openFolder = welcome.getByRole('button', { name: 'Open Folder', exact: true });
	await openFolder.focus();
	await expect(openFolder).toBeFocused();
	await expect(openFolder).toBeEnabled();
	expect(
		runningApplication.diagnostics.consoleErrors.filter(error => /github.*link|editorPartsService/i.test(error)),
	).toEqual([]);
});
