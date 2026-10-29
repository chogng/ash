import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Electron Workbench and Agents open without preparing the App Server package', { tag: ['@electron-ui'] }, async ({ workbench, target, runningApplication }) => {
	const applicationMenu = workbench.page.getByRole('button', { name: 'Application menu' });
	await expect(applicationMenu).toHaveCount(process.platform === 'darwin' ? 0 : 1);
	await expect(workbench.page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button')).toBeVisible();
	await expect(workbench.page.getByRole('region', { name: 'Editor', exact: true })).toBeVisible();
	const agents = await workbench.openAgentsWindow(target.kind);
	await expect(agents.locator('.ash-sessions-window[aria-busy="false"]')).toBeVisible();
	expect(runningApplication.diagnostics.errors).toEqual([]);
});
