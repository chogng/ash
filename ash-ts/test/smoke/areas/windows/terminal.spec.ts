import { expect, test } from '../../../automation/test.js';

test('terminal panel preserves focus, accepts input and retains instances when reopened', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires the Code App Server product');
	const page = workbench.page;
	await expect(page.locator('.xterm')).toHaveCount(0);
	const showPanel = page.getByRole('button', { name: 'Show Panel', exact: true });
	await showPanel.click();
	const terminal = page.locator('.ash-terminal-instance:visible');
	await expect(terminal).toHaveAttribute('data-state', 'running');
	await expect(terminal.locator('.xterm-helper-textarea')).not.toBeFocused();
	await terminal.locator('.xterm-helper-textarea').focus();
	await page.keyboard.type("printf 'ash-%s\\n' 'terminal-ready'");
	await page.keyboard.press('Enter');
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
	await page.getByRole('button', { name: 'Hide Panel', exact: true }).click();
	await expect(terminal).toHaveCount(0);
	await showPanel.click();
	await expect(page.locator('.xterm')).toHaveCount(1);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
	await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(2);
	await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
	await page.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
	await showPanel.click();
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(1);
	await expect(page.locator('.xterm')).toHaveCount(1);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
});
