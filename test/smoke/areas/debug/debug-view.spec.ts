import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Run and Debug opens a welcome pane in an empty window', async ({ workbench, runningApplication }) => {
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.locator('.ash-debug-section .ash-pane-view-header-title')).toHaveText(['Run']);
	await expect(pane.getByRole('button', { name: 'Open Folder', exact: true })).toBeVisible();
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toBeHidden();
	await expect(pane.locator('.ash-debug-variables, .ash-debug-watch, .ash-debug-stack, .ash-debug-empty')).toHaveCount(0);
	const run = pane.getByRole('button', { name: 'Run', exact: true });
	await run.focus();
	await run.press('ArrowLeft');
	await expect(run).toHaveAttribute('aria-expanded', 'false');
	await expect(pane.getByRole('button', { name: 'Open Folder', exact: true })).toBeHidden();
	await run.press('ArrowRight');
	await expect(pane.getByRole('button', { name: 'Open Folder', exact: true })).toBeVisible();
	expect(runningApplication.diagnostics.consoleErrors.filter(error => /github.*link|editorPartsService/i.test(error))).toEqual([]);
});
