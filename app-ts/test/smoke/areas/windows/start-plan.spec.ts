import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Start Plan connections appear in Manage Accounts and keyboard cancellation restores the picker', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the account backend.');
	const picker = workbench.quickaccess;
	await picker.runCommand('workbench.action.manageAccounts');
	await expect(picker.input).toHaveAttribute('placeholder', 'Select an account to manage');
	await picker.select('Add account');
	await expect(picker.input).toBeFocused();
	await expect(picker.items).toContainText(['Sign in with BigModel Start Plan', 'Sign in with Z.AI Start Plan']);
	await picker.search('Z.AI Start Plan');
	await expect(picker.items).toHaveCount(1);
	await expect(picker.items).toContainText('Sign in with Z.AI Start Plan');
	await picker.input.press('Escape');
	await expect(picker.element).toHaveCount(0);
	await picker.runCommand('workbench.action.manageAccounts');
	await expect(picker.input).toHaveAttribute('placeholder', 'Select an account to manage');
});
