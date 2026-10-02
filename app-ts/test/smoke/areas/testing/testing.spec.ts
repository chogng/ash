import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';

const source = `fn main() {}\n#[cfg(test)]\nmod checks {\n    #[test] fn passes() {\n        assert_eq!(2 + 2, 4);\n    }\n    #[test] fn fails() { panic!("fixture failure"); }\n    #[test] #[ignore] fn ignored() {}\n    #[test] fn slow() { std::thread::sleep(std::time::Duration::from_secs(20)); }\n}\n`;

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
	test('Rust test debugging hits a real breakpoint and macro and documentation tests execute', async ({ workbench, testWorkspace }) => {
		test.setTimeout(120_000);
		await writeFile(testWorkspace.rustFile, source + '\nmacro_rules! generated { () => { #[test] fn generated_case() { assert_eq!(3, 3); } } }\n#[cfg(test)] generated!();\n');
		const manifest = join(testWorkspace.directory, 'Cargo.toml');
		await writeFile(manifest, await readFile(manifest, 'utf8') + '\n[lib]\npath = "lib.rs"\n');
		await writeFile(join(testWorkspace.directory, 'lib.rs'), '/// ```\n/// assert_eq!(2 + 2, 4);\n/// ```\npub fn docs() {}\n');
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.testing.refresh');
		await page.getByRole('tab', { name: 'Testing', exact: true }).first().click();
		const pane = page.locator('[data-view-id="ash.testing.view"]');
		const tree = pane.getByRole('tree', { name: 'Tests' });
		await expect(tree).toContainText('generated_case');
		await expect(tree).toContainText('Documentation Tests');
		await tree.getByRole('treeitem').filter({ has: page.locator('.ash-testing-row > span:first-child', { hasText: 'generated_case' }) }).click();
		await pane.getByRole('button', { name: 'Run Selected', exact: true }).click();
		await expect(pane.getByRole('status')).toContainText('1 passed');
		await tree.getByRole('treeitem').filter({ has: page.locator('.ash-testing-row > span:first-child', { hasText: 'lib.rs - docs' }) }).click();
		await expect(pane.getByRole('button', { name: 'Debug Selected Test', exact: true })).toBeDisabled();
		await pane.getByRole('button', { name: 'Run Selected', exact: true }).click();
		await expect(pane.getByRole('status')).toContainText('2 passed');
		const passes = tree.getByRole('treeitem').filter({ has: page.locator('.ash-testing-row > span:first-child', { hasText: 'checks::passes' }) });
		await passes.click();
		await passes.press('Enter');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorContents(contents => contents.includes('fn passes()'));
		await editor.waitForEditorFocus();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('F9');
		await expect(editor.element.locator('.ash-debug-breakpoint-gutter')).toHaveCount(1);
		await editor.waitForEditorFocus();
		await page.keyboard.press('F9');
		await expect(editor.element.locator('.ash-debug-breakpoint-gutter')).toHaveCount(0);
		await page.keyboard.press('F9');
		await expect(editor.element.locator('.ash-debug-breakpoint-gutter')).toHaveCount(1);
		await passes.click();
		await pane.getByRole('button', { name: 'Debug Selected Test', exact: true }).click();
		await expect(pane.getByRole('status')).toHaveText('Debugging test…', { timeout: 30_000 });
		await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
		const debug = page.locator('[data-view-id="workbench.view.debug"]');
		await expect(debug.getByRole('status')).toContainText('stopped');
		await expect(debug.locator('.ash-debug-stack')).toContainText('checks::passes');
		await expect(editor.element.locator('.ash-debug-breakpoint-gutter.verified')).toHaveCount(1);
		// Macro expressions can resolve to multiple instruction locations on one line.
		// Retire the verified breakpoint before checking continuation and session cleanup.
		await debug.locator('.ash-debug-breakpoint-remove').click();
		await expect(editor.element.locator('.ash-debug-breakpoint-gutter')).toHaveCount(0);
		await debug.getByRole('button', { name: 'Continue', exact: true }).click();
		await expect(debug.getByRole('status')).toHaveText('Add a debug configuration in .vscode/launch.json to get started.');
		await page.getByRole('tab', { name: 'Testing', exact: true }).first().click();
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


test.describe('Run and Debug sidebar layout', () => {
	test.use({ openWorkspace: false });

	test('debug sidebar has a compact launch row, keyboard collapsible sections and readable themes', async ({ target, workbench }) => {
		test.skip(target.workbenchMode !== 'code', 'Requires the Code workbench.');
		const page = workbench.page;
		const tab = page.getByRole('tab', { name: 'Run and Debug', exact: true }).first();
		await tab.click();
		await expect(tab.locator('[data-ash-icon-id="debug-alt"]')).toBeVisible();
		const pane = page.locator('[data-view-id="workbench.view.debug"]');
		const start = pane.getByRole('button', { name: 'Start Debugging', exact: true });
		const configuration = pane.getByRole('combobox', { name: 'Debug configuration', exact: true });
		await expect(start).toBeDisabled();
		await expect(configuration).toBeDisabled();
		await expect(configuration).toHaveText('No debug configurations');
		await expect(pane.getByRole('toolbar', { name: 'Debug controls' })).toBeHidden();
		const summary = pane.locator('summary', { hasText: 'Watch' });
		const input = pane.getByRole('textbox', { name: 'Add watch expression' });
		await input.fill('myValue');
		await summary.focus();
		await summary.press('Enter');
		await expect(input).toBeHidden();
		await summary.press('Space');
		await expect(input).toHaveValue('myValue');
		await expect(summary).toBeFocused();
		await expect(summary).toHaveCSS('outline-style', 'solid');

		for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill(theme);
			await picker.getByRole('combobox').press('Enter');
			await expect(picker).toHaveCount(0);
			await summary.focus();
			await expect(summary).toHaveCSS('outline-style', 'solid');
			expect(await summary.evaluate(element => getComputedStyle(element).outlineColor === getComputedStyle(element).backgroundColor)).toBe(false);
		}

		// Exercise the view at the sidebar's supported narrow size without touching its inner styles.
		const sidebar = page.locator('[data-part="sidebar"]');
		const sidebarBounds = await sidebar.boundingBox();
		expect(sidebarBounds).not.toBeNull();
		const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
		const bounds = await sash.boundingBox();
		expect(bounds).not.toBeNull();
		await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
		await page.mouse.down();
		await page.mouse.move(sidebarBounds!.x + 220, bounds!.y + bounds!.height / 2);
		await page.mouse.up();
		const geometry = await pane.locator('.ash-debug-launch').evaluate(element => {
			const row = element.getBoundingClientRect();
			return { width: row.width, fits: [...element.children].every(child => { const rect = child.getBoundingClientRect(); return rect.left >= row.left && rect.right <= row.right + 1; }) };
		});
		expect(geometry.width).toBeGreaterThan(0);
		expect(geometry.width).toBeLessThan(240);
		expect(geometry.fits).toBe(true);
		expect(await pane.locator('.ash-debug').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const languagePicker = page.getByRole('dialog', { name: 'Select Display Language' });
		await languagePicker.getByRole('combobox').fill('简体中文');
		await languagePicker.getByRole('combobox').press('Enter');
		await expect(languagePicker).toHaveCount(0);
		await expect(pane.getByRole('combobox', { name: '调试配置', exact: true })).toHaveText('没有调试配置');
		await expect(pane.getByRole('button', { name: '启动调试', exact: true })).toBeDisabled();
		await expect(pane.getByRole('textbox', { name: '添加监视表达式' })).toHaveValue('myValue');
		await expect(pane.locator('summary', { hasText: '监视' })).toBeVisible();
	});
});
