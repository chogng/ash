import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);
const commitShortcut = process.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter';

test('SCM hides the commit form when no repository is available', async ({ workbench }) => {
	await workbench.page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const changes = workbench.page.locator('[data-view-id="ash.gitView"]');
	await expect(changes.locator('.ash-scm-empty')).toBeVisible();
	await expect(changes.locator('.ash-scm-commit-form')).toBeHidden();
});

test.describe('SCM commit input', () => {
	test.use({ gitRepository: true });
	test.beforeEach(async ({ target }) => {
		test.skip(target.appServerMode !== 'required', 'Commit editing requires a connected repository.');
	});

	test('SCM commit input grows, wraps, shrinks and supports undo and redo', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		const placeholder = input.locator('.stanza-editor-placeholder-text');
		await expect(placeholder).toHaveText(`Message (${commitShortcut} to commit on "main")`);
		await expect(input).toHaveCSS('resize', 'none');
		await expect.poll(() => input.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(26);
		await editor.focus();
		await page.keyboard.insertText('Subject');
		await editor.press('Enter');
		await page.keyboard.insertText('Body');
		await expect.poll(() => input.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(46);
		await expect(placeholder).toBeHidden();
		await editor.press('ControlOrMeta+z');
		await expect(input.locator('.view-lines')).not.toContainText('Body');
		await editor.press('ControlOrMeta+Shift+z');
		await expect(input.locator('.view-lines')).toContainText('Body');
		await editor.press('ControlOrMeta+a');
		await page.keyboard.insertText('Long commit message '.repeat(50));
		await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(46);
		await editor.press('ControlOrMeta+a');
		await page.keyboard.insertText(Array.from({ length: 12 }, (_, index) => `Message line ${index + 1}`).join('\n'));
		await expect.poll(() => input.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(206);
		expect((await input.locator('.margin-view-overlays .line-numbers').allTextContents()).every(text => text.trim() === '')).toBe(true);
		await editor.press('ControlOrMeta+a');
		await editor.press('Backspace');
		await expect.poll(() => input.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(26);
		await expect(placeholder).toBeVisible();
	});

	test('SCM commit input restores focus from help and lets Tab reach Commit', async ({ testWorkspace, workbench }) => {
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await run('git', ['add', 'main.ts'], { cwd: testWorkspace.directory });
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const editor = page.locator('.ash-scm-input').getByRole('textbox', { name: /^Commit message/u });
		const commit = page.locator('.ash-scm-commit');
		await expect(commit).toBeEnabled();
		await editor.focus();
		await editor.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(help.getByRole('textbox')).toHaveValue(/Enter inserts a new line/u);
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await editor.press('Tab');
		await expect(commit).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(editor).toBeFocused();
	});

	test('SCM commit input uses input colors and visible focus in all four themes', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		for (const theme of ['Ash Dark', 'Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			await workbench.quickaccess.select(theme);
			await editor.focus();
			await expect(input).toHaveCSS('outline-style', 'solid');
			const colors = await input.evaluate(element => {
				const probe = element.ownerDocument.createElement('span');
				probe.style.backgroundColor = 'var(--ash-input-background)';
				probe.style.color = 'var(--ash-input-foreground)';
				element.append(probe);
				const expected = getComputedStyle(probe);
				const actual = getComputedStyle(element);
				const matches = actual.backgroundColor === expected.backgroundColor && actual.color === expected.color;
				probe.remove();
				return matches;
			});
			expect(colors).toBe(true);
		}
	});

	test('SCM commits the edited message with Ctrl+Enter and clears the draft', async ({ testWorkspace, workbench }) => {
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await run('git', ['add', 'main.ts'], { cwd: testWorkspace.directory });
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		await expect(page.locator('.ash-scm-commit')).toBeEnabled();
		await editor.focus();
		await page.keyboard.insertText('SCM editor commit');
		await editor.press('Enter');
		await page.keyboard.insertText('Preserve the message body.');
		await editor.press('ControlOrMeta+Enter');
		await expect.poll(async () => (await run('git', ['log', '-1', '--format=%B'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('SCM editor commit\nPreserve the message body.');
		await expect(input.locator('.stanza-editor-placeholder-text')).toBeVisible();
		await expect.poll(() => input.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(26);
		await expect(editor).toBeFocused();
	});

	test('SCM keeps separate commit drafts when switching repositories', async ({ testWorkspace, workbench }) => {
		const nested = join(testWorkspace.directory, 'nested');
		await mkdir(nested);
		await run('git', ['init', '-b', 'topic'], { cwd: nested });
		await writeFile(join(nested, 'nested.txt'), 'nested repository\n');
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const repositories = page.getByRole('listbox', { name: 'Source control repositories', exact: true });
		await expect(repositories.getByRole('option')).toHaveCount(2);
		const primary = repositories.getByRole('option', { name: /, main,/u });
		const secondary = repositories.getByRole('option', { name: /nested, topic,/u });
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		await primary.click();
		await editor.focus();
		await page.keyboard.insertText('Main draft');
		await secondary.click();
		await expect(input.locator('.stanza-editor-placeholder-text')).toHaveText(`Message (${commitShortcut} to commit on "topic")`);
		await editor.focus();
		await page.keyboard.insertText('Topic draft');
		await primary.click();
		await expect(input.locator('.view-lines')).toContainText('Main draft');
		await secondary.click();
		await expect(input.locator('.view-lines')).toContainText('Topic draft');
	});
});
