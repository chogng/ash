import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';

const source = `fn main() {}\n#[cfg(test)]\nmod checks {\n    #[test] fn passes() { assert_eq!(2 + 2, 4); }\n    #[test] fn fails() { panic!("fixture failure"); }\n    #[test] #[ignore] fn ignored() {}\n    #[test] fn slow() { std::thread::sleep(std::time::Duration::from_secs(20)); }\n}\n`;

test.describe('built-in Rust testing', () => {
	test.beforeEach(async ({ target, testWorkspace }) => {
		test.skip(target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires the Rust testing backend and Code workbench.');
		await writeFile(testWorkspace.rustFile, source);
	});

	test('Rust testing discovers cases, saves edits, runs exact cases and cancels execution', async ({ workbench, testWorkspace }) => {
		test.setTimeout(120_000);
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.testing.refresh');
		await page.getByRole('tab', { name: 'Testing', exact: true }).first().click();
		const pane = page.locator('[data-view-id="ash.testing.view"]');
		const tree = pane.getByRole('tree', { name: 'Tests' });
		await expect(tree).toContainText('checks::passes');
		await expect(tree).toContainText('checks::fails');
		const select = async (name: string) => { await tree.getByRole('treeitem').filter({ has: page.locator('.ash-testing-row > span:first-child', { hasText: name }) }).click(); };
		await select('checks::passes');
		await pane.getByRole('button', { name: 'Run Selected', exact: true }).click();
		await expect(pane.getByRole('status')).toContainText('1 passed');
		await select('checks::fails');
		await pane.getByRole('button', { name: 'Run Selected', exact: true }).click();
		await expect(pane.getByRole('status')).toContainText('1 failed');
		await expect(pane.getByRole('region', { name: 'Test result' })).toContainText('fixture failure');
		await pane.getByRole('button', { name: 'Open Failure Location', exact: true }).click();
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+A');
		await page.keyboard.insertText(source.replace('panic!("fixture failure");', 'assert!(true);'));
		await expect(page.locator('.ash-testing-gutter')).toHaveCount(0);
		await pane.getByRole('button', { name: 'Rerun Failed', exact: true }).click();
		await expect(pane.getByRole('status')).toContainText('2 passed');
		expect(await readFile(testWorkspace.rustFile, 'utf8')).toContain('assert!(true);');
		await select('checks::ignored');
		await pane.getByRole('button', { name: 'Run Selected', exact: true }).click();
		await expect(pane.getByRole('status')).toContainText('1 skipped');
		await select('checks::slow');
		await pane.getByRole('button', { name: 'Run Selected', exact: true }).click();
		await expect(tree).toContainText('Running');
		await pane.getByRole('button', { name: 'Cancel Tests', exact: true }).click();
		await expect(tree).toContainText('Cancelled');
		await expect(pane.getByRole('button', { name: 'Run All Tests', exact: true })).toBeEnabled();
	});
});

test.describe('testing without a backend', () => {
	test.use({ openWorkspace: false });
	test.beforeEach(({ target }) => {
		test.skip(target.appServerMode !== 'disabled' || target.workbenchMode !== 'code', 'Checks UI-only workbench availability.');
	});
	test('Testing opens with accessible controls and disables execution without discovered cases', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: 'Testing', exact: true }).first().click();
		const pane = page.locator('[data-view-id="ash.testing.view"]');
		await expect(pane.getByRole('tree', { name: 'Tests' })).toHaveAttribute('aria-description', /arrow keys/);
		await expect(pane.getByRole('button', { name: 'Refresh Tests', exact: true })).toBeVisible();
		await expect(pane.getByRole('button', { name: 'Run All Tests', exact: true })).toBeDisabled();
		await expect(pane.getByRole('button', { name: 'Refresh Tests', exact: true })).toBeEnabled();
	});
});
