import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.use({ useDefaultLanguageServer: false });

test(
	'built-in CSS supplies completion, diagnostics, hover and formatting without installing extensions',
	{ tag: ['@electron-app-server'] },
	async ({ workbench, testWorkspace }, testInfo) => {
		await writeFile(join(testWorkspace.directory, 'style.css'), 'body {\n  col\n}\n');
		await writeFile(join(testWorkspace.directory, 'format.css'), 'body{color:red;madeupprop:1;}');
		const page = workbench.page;
		await workbench.openExplorer();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'style.css', exact: true }).dblclick();
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await expect(editor.element.locator('.squiggly-error')).not.toHaveCount(0);
		await editor.input.press('ControlOrMeta+Home');
		await editor.input.press('ArrowDown');
		await editor.input.press('End');
		await workbench.quickaccess.runCommand('editor.action.triggerSuggest');
		const color = page
			.locator('.stanza-editor-completion-option:visible')
			.filter({ has: page.locator('.stanza-editor-completion-label').getByText('color', { exact: true }) });
		await expect(color).toBeVisible();
		await color.click();
		await editor.waitForTypeInEditor('red');
		await editor.waitForEditorContents(contents => contents === 'body {\n  color: red;\n}\n');
		await editor.input.press('Escape');
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'format.css', exact: true }).dblclick();
		await editor.waitForEditorFocus();
		await expect(editor.element.locator('.squiggly-warning')).not.toHaveCount(0);
		await workbench.quickaccess.runCommand('editor.action.formatDocument');
		await editor.waitForEditorContents(contents => contents.includes('\n') && contents.includes('color: red'));
		await expect(editor.element.locator('.squiggly-error')).toHaveCount(0);
		await editor.element.getByText('color', { exact: true }).hover();
		await expect(page.locator('.stanza-editor-hover:visible')).toContainText("Sets the color of an element's text");
		await expect(page.locator('.stanza-editor-hover:visible')).not.toContainText('data:image');
		await expect(
			page.locator('.ash-notifications-row').filter({ hasText: /Recommended for CSS|JSON Language Support/u }),
		).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath('builtin-css.png') });
	},
);

test(
	'built-in TypeScript checks types and navigates across files without installing extensions',
	{ tag: ['@electron-app-server'] },
	async ({ workbench, testWorkspace }, testInfo) => {
		await writeFile(
			join(testWorkspace.directory, 'tsconfig.json'),
			'{"compilerOptions":{"strict":true,"target":"ES2022","module":"commonjs"}}',
		);
		await writeFile(join(testWorkspace.directory, 'model.ts'), 'export const value = { name: "Ash" };\n');
		await writeFile(
			testWorkspace.file,
			'import { value } from "./model";\nconst bad: number = "oops";\nvalue.name;\n',
		);
		const page = workbench.page;
		await workbench.openExplorer();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		const group = workbench.editors.groupAt(0);
		await expect(group.editor.element.locator('.squiggly-error')).not.toHaveCount(0);
		await page.locator('[data-statusbar-item-id="ash.status.problems"]').click();
		await expect(
			page.getByText("Type 'string' is not assignable to type 'number'.", { exact: true }),
		).toBeVisible();
		await workbench.quickaccess.runCommand('workbench.action.togglePanel');
		await group.editor.waitForEditorFocus();
		await group.editor.input.press('ControlOrMeta+Home');
		await group.editor.input.press('ArrowDown');
		await group.editor.input.press('ArrowDown');
		await group.editor.input.press('Home');
		for (let character = 0; character < 7; character++) await group.editor.input.press('ArrowRight');
		await group.editor.input.press('F12');
		await expect(group.tabs.filter({ hasText: 'model.ts' })).toHaveAttribute('aria-selected', 'true');
		await group.editor.waitForEditorContents(contents => contents.includes('export const value'));
		await expect(
			page.locator('.ash-notifications-row').filter({ hasText: 'TypeScript Language Support' }),
		).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath('builtin-typescript.png') });
	},
);
