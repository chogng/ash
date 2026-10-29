import { expect, test } from '../../../automation/test.js';

test.use({ reportIssueUrl: 'https://github.com/chogng/ash/issues' });

test('the product issue reporter opens from the command palette, preserves its draft and restores keyboard focus', async ({ workbench, target }) => {
	const page = workbench.page;
	const open = (): Promise<void> => workbench.quickaccess.runCommand('workbench.action.openIssueReporter');
	await open();
	const reporter = page.locator('.ash-issue-reporter'); await expect(reporter).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect(reporter.locator('.issue-reporter-target')).toHaveAttribute('href', 'https://github.com/chogng/ash/issues');
		await reporter.getByText('Preview the report that will be submitted', { exact: true }).click();
		await expect(reporter.locator('pre')).toContainText(/Ash: \S+/u);
		await expect(reporter.locator('pre')).toContainText(/OS: \S+ \(\S+\)/u);
		await expect(reporter.locator('pre')).toContainText('App Server');
		await expect(reporter.locator('pre')).toContainText('Browser:');
		if (target.kind === 'electron') {
			await expect(reporter.locator('pre')).toContainText('Desktop\nOS:');
			await expect(reporter.locator('pre')).toContainText('CPU:');
			await expect(reporter.locator('pre')).toContainText('Memory:');
			await expect(reporter.locator('pre')).toContainText('Desktop processes');
			await expect(reporter.locator('pre')).toContainText('Ash Main');
			await expect(reporter.locator('pre')).not.toContainText('could not be collected');
		} else { await expect(reporter.locator('pre')).not.toContainText('Desktop\nOS:'); }
	}
	await reporter.getByRole('textbox', { name: 'Title', exact: true }).fill('Retained product report');
	const description = reporter.getByRole('textbox', { name: 'Description', exact: true });
	await description.fill('Reproduction steps'); await description.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help' })).toBeVisible();
	await expect(page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/App Server and browser details separately/);
	await page.keyboard.press('Escape'); await expect(description).toBeFocused();
	await page.getByRole('button', { name: 'Close Report an issue', exact: true }).click();
	await expect(reporter).toHaveCount(0); await open();
	await expect(reporter.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Retained product report');
	await expect(reporter.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Reproduction steps');
});
