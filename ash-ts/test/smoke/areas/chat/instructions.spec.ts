import { expect, test } from '../../../automation/test.js';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Open file can be attached to Chat by keyboard in the Code workbench', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario needs the connected Code workbench.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Primary Side Bar' }).click();
	const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	await expect(file).toBeVisible();
	await file.click();
	await expect(workbench.editors.groupAt(0).tabs.first()).toContainText('main.ts');
	await page.getByRole('button', { name: 'Show Secondary Side Bar' }).click();

	const attach = page.locator('.ash-chat-input-attachment button');
	await expect(attach).toBeVisible();
	await attach.click();
	const picker = page.locator('.ash-quick-pick');
	await expect(picker).toBeVisible();
	await picker.locator('.ash-quick-pick-input input').fill('Open files');
	await page.keyboard.press('Enter');
	await expect(picker).toBeVisible();
	await picker.locator('.ash-quick-pick-input input').fill('main.ts');
	await page.keyboard.press('Enter');

	await expect(page.locator('.ash-chat-input-attachment-label')).toHaveText(await realpath(testWorkspace.file));
	await expect(page.getByRole('textbox', { name: 'Chat message' })).toBeFocused();
});

test('OnDemand Instruction can be selected from Chat attachments by keyboard', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario needs the connected Code workbench.');
	const instructionDir = join(testWorkspace.directory, '.ash/instructions');
	await mkdir(instructionDir, { recursive: true });
	await writeFile(join(instructionDir, 'manual.md'), '---\nname: manual\nload: on-demand\n---\n\nManual rule.\n');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Primary Side Bar' }).click();
	await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' }).click();
	await page.getByRole('button', { name: 'Show Secondary Side Bar' }).click();
	await page.locator('.ash-chat-input-attachment button').click();
	const picker = page.locator('.ash-quick-pick');
	await expect(picker).toBeVisible();
	await picker.locator('.ash-quick-pick-input input').fill('Instructions');
	await page.keyboard.press('Enter');
	await expect(picker).toBeVisible();
	await picker.locator('.ash-quick-pick-input input').fill('manual');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-chat-input-attachment-label')).toHaveText('Instruction: manual');
	await expect(page.getByRole('textbox', { name: 'Chat message' })).toBeFocused();
});

test('Instruction diagnostics are visible from the command palette', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario needs the connected Code workbench.');
	const instructionDir = join(testWorkspace.directory, '.ash/instructions');
	await mkdir(instructionDir, { recursive: true });
	await writeFile(join(instructionDir, 'invalid.md'), 'Missing frontmatter.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Show Instruction Diagnostics');
	await page.keyboard.press('Enter');
	const diagnostics = page.getByRole('dialog', { name: 'Instruction Diagnostics' });
	await expect(diagnostics).toBeVisible();
	await expect(diagnostics).toContainText('invalid.md');
	await expect(diagnostics).toContainText('invalidFrontmatter');
	await diagnostics.getByRole('button', { name: 'OK' }).click();
});

test('Claude workspace instructions are reviewed and copied without overwriting Ash rules', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario needs the connected Code workbench.');
	const page = workbench.page;
	const content = 'Keep this exact Claude instruction.\n'.repeat(160);
	const source = join(testWorkspace.directory, 'CLAUDE.md');
	const targetFile = join(testWorkspace.directory, 'ASH.md');
	await writeFile(source, content);

	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Import Claude Workspace Instructions');
	await page.keyboard.press('Enter');
	const review = page.getByRole('dialog', { name: 'Review Claude instructions' });
	await expect(review).toBeVisible();
	await expect(review.locator('.ash-dialog-detail')).toContainText('Keep this exact Claude instruction.');
	await expect(review.getByRole('button', { name: 'Import' })).toBeVisible();
	await expect.poll(() => review.locator('.ash-dialog-detail').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
	await review.locator('.ash-dialog-detail').focus();
	await expect(review.locator('.ash-dialog-detail')).toBeFocused();
	await page.keyboard.press('End');
	await expect.poll(() => review.locator('.ash-dialog-detail').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await review.getByRole('button', { name: 'Import' }).click();
	await expect.poll(() => readFile(targetFile, 'utf8').catch(() => undefined)).toBe(content);
	await page.getByRole('dialog', { name: 'Import Claude instructions' }).getByRole('button', { name: 'OK' }).click();

	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Import Claude Workspace Instructions');
	await page.keyboard.press('Enter');
	const conflict = page.getByRole('dialog', { name: 'Import Claude instructions' });
	await expect(conflict).toContainText('already has content');
	await conflict.getByRole('button', { name: 'OK' }).click();
	await expect.poll(() => readFile(targetFile, 'utf8').catch(() => undefined)).toBe(content);
});
