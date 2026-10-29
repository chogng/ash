import { expect, test } from '../../../automation/test.js';

test('Ports resolves the runtime tunnel service and disables forwarding in a local workspace', async ({ application, workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.focusPanel');
	const ports = page.getByRole('tab', { name: 'Ports', exact: true });
	const panel = page.locator('[data-part="panel"]');
	await expect(panel).toBeVisible();
	const overflow = panel.getByRole('tab', { name: 'Additional views' });
	if (await overflow.isVisible()) {
		await workbench.menus.select(application, () => overflow.click(), ['Ports']);
	} else {
		await ports.click();
	}
	const pane = page.locator('.ash-remote-ports');
	await expect(pane.getByRole('status')).toHaveText('Forwarded ports are available in an SSH Remote Workspace.');
	await expect(pane.getByRole('spinbutton', { name: 'Remote port' })).toBeDisabled();
	await expect(pane.getByRole('button', { name: 'Forward Port', exact: true })).toBeDisabled();
	await expect(pane.getByRole('button', { name: 'Stop All', exact: true })).toBeDisabled();
	await expect(pane.getByRole('list', { name: 'Forwarded ports' })).toBeEmpty();
	await ports.focus();
	await expect(ports).toBeFocused();
	await ports.press('Enter');
	await expect(pane).toBeVisible();
});
