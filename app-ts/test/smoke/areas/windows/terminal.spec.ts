import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('terminal panel preserves focus, accepts input and retains instances when reopened', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the Code App Server product');
	const page = workbench.page;
	await expect(page.locator('.xterm')).toHaveCount(0);
	await workbench.terminal.show();
	const terminal = workbench.terminal.activeInstance;
	await expect(terminal).toHaveAttribute('data-state', 'running');
	await expect(terminal.locator('.xterm-helper-textarea')).not.toBeFocused();
	// Build the marker in the child so echoed input cannot satisfy the output assertion.
	await workbench.terminal.runCommand(`node -e "console.log(['ash','terminal-ready'].join('-'))"`);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
	await page.getByRole('button', { name: 'Hide Panel', exact: true }).click();
	await expect(terminal).toHaveCount(0);
	await workbench.terminal.show();
	await expect(page.locator('.xterm')).toHaveCount(1);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
	await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(2);
	await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
	await page.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
	await workbench.terminal.show();
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(1);
	await expect(page.locator('.xterm')).toHaveCount(1);
	await expect(terminal.locator('.xterm-rows')).toContainText('ash-terminal-ready');
});

test('terminal instances keep output separate and start in the workspace', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the Code App Server product');
	const terminal = workbench.terminal;
	await terminal.show();
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await terminal.runCommand(`node -e "require('fs').writeFileSync('terminal-cwd.txt','workspace'); console.log(['ash','first-terminal'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-first-terminal');
	expect(await readFile(join(testWorkspace.directory, 'terminal-cwd.txt'), 'utf8')).toBe('workspace');

	await workbench.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(terminal.instances).toHaveCount(2);
	await expect(terminal.tabs).toHaveCount(2);
	await expect(terminal.tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
	await expect(terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-first-terminal');
	await terminal.runCommand(`node -e "console.log(['ash','second-terminal'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-second-terminal');

	await terminal.tabs.nth(0).click();
	await expect(terminal.tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-first-terminal');
	await expect(terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-second-terminal');
	await terminal.tabs.nth(1).click();
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-second-terminal');
	await expect(terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-first-terminal');
});

test('terminal relaunches an exited shell and accepts new commands', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the Code App Server product');
	const terminal = workbench.terminal;
	await terminal.show();
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await terminal.runCommand('exit 17');
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'exited');
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('[process exited with code 17]');
	await workbench.page.getByRole('button', { name: 'Relaunch Terminal', exact: true }).click();
	await expect(terminal.instances).toHaveCount(1);
	await expect(terminal.activeInstance).toHaveAttribute('data-state', 'running');
	await expect(terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await terminal.runCommand(`node -e "console.log(['ash','relaunched-terminal'].join('-'))"`);
	await expect(terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-relaunched-terminal');
});
