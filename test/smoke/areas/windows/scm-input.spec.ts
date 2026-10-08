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
	await expect(changes.getByRole('region', { name: 'Welcome', exact: true })).toBeVisible();
	await expect(changes.locator('.ash-scm-commit-form')).toBeHidden();
	await expect(changes.locator('.ash-pane-view-header')).toBeHidden();
	await expect(workbench.page.locator('.ash-scm-viewlet [data-view-id]')).toHaveAttribute('data-view-id', 'ash.gitView');
});

test.describe('SCM welcome', () => {
	test.use({ openWorkspace: false });

	test('SCM welcome shows host actions and restores keyboard focus from help', async ({ target, workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const welcome = page.locator('[data-view-id="ash.gitView"]').getByRole('region', { name: 'Welcome', exact: true });
		await expect(welcome).toContainText('Open a folder containing a Git repository');
		await expect(page.locator('.ash-scm-viewlet [data-view-id]')).toHaveAttribute('data-view-id', 'ash.gitView');
		await expect(page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header')).toBeHidden();
		const open = welcome.getByRole('button', { name: 'Open Folder', exact: true });
		await expect(open).toBeEnabled();
		if (target.kind === 'electron') {
			const clone = welcome.getByRole('button', { name: 'Clone Repository', exact: true });
			await expect(clone).toBeVisible();
			await clone.click();
			await expect(page.getByRole('dialog', { name: 'Clone Repository', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
		} else {
			await expect(welcome.getByRole('button', { name: 'Clone Repository', exact: true })).toHaveCount(0);
		}
		await open.focus();
		await open.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(help.getByRole('textbox')).toHaveValue(/Use Tab and Shift\+Tab/u);
		await page.keyboard.press('Escape');
		await expect(open).toBeFocused();
	});

	test('SCM welcome wraps in a narrow pane and uses theme colors and keyboard focus', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const welcome = page.locator('[data-view-id="ash.gitView"] .ash-view-welcome');
		const open = welcome.getByRole('button', { name: 'Open Folder', exact: true });
		for (const theme of ['Ash Dark', 'Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			await workbench.quickaccess.select(theme);
			await open.focus();
			await expect(open).toHaveCSS('outline-style', 'solid');
			const colors = await open.evaluate(element => {
				const probe = element.ownerDocument.createElement('span');
				probe.style.backgroundColor = 'var(--ash-button-primaryBackground)';
				probe.style.color = 'var(--ash-focusBorder)';
				element.append(probe);
				const actual = getComputedStyle(element);
				const expected = getComputedStyle(probe);
				const result = { background: actual.backgroundColor, expectedBackground: expected.backgroundColor, outline: actual.outlineColor, expectedOutline: expected.color };
				probe.remove();
				return result;
			});
			expect(colors.background).toBe(colors.expectedBackground);
			expect(colors.outline).toBe(colors.expectedOutline);
		}
		const sidebar = page.locator('[data-part="sidebar"]');
		const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
		const sidebarBounds = (await sidebar.boundingBox())!;
		const sashBounds = (await sash.boundingBox())!;
		const x = sashBounds.x + sashBounds.width / 2;
		const y = sashBounds.y + sashBounds.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 240 - sidebarBounds.width, y);
		await page.mouse.up();
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(240, 0);
		await expect.poll(() => welcome.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	});
});

test('SCM welcome initializes a repository through the backend and returns to Changes', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Repository initialization requires a connected backend.');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const changes = page.locator('[data-view-id="ash.gitView"]');
	await expect(page.locator('.ash-scm-viewlet [data-view-id]')).toHaveAttribute('data-view-id', 'ash.gitView');
	await expect(changes.locator('.ash-pane-view-header')).toBeHidden();
	await changes.getByRole('button', { name: 'Initialize Repository', exact: true }).click();
	await page.locator('.ash-quick-pick').getByRole('option').first().click();
	const branch = page.getByRole('dialog', { name: 'Quick Input', exact: true }).getByRole('textbox');
	await branch.fill('welcome-main');
	await branch.press('Enter');
	await expect.poll(() => run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: testWorkspace.directory }).then(result => result.stdout.trim(), () => undefined)).toBe('welcome-main');
	await expect(changes.getByRole('region', { name: 'Welcome', exact: true })).toBeHidden();
	await expect(changes.locator('.ash-scm-commit-form')).toBeVisible();
	await expect(changes.locator('.ash-pane-view-header')).toBeVisible();
	await expect(page.locator('[data-view-id="ash.gitAgentReview"] .ash-pane-view-header')).toBeVisible();
	await expect(page.locator('[data-view-id="ash.gitGraph"] .ash-pane-view-header')).toBeVisible();
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
		await expect(help.getByRole('textbox')).toHaveValue(/Commit All asks whether to include untracked files/u);
		await expect(help.getByRole('textbox')).toHaveValue(/Signed-off-by/u);
		await expect(help.getByRole('textbox')).toHaveValue(/restores its complete message only to an unchanged empty draft/u);
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await editor.press('Tab');
		await expect(commit).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(editor).toBeFocused();
	});

	test('SCM commit input localizes scope and draft help after restarting in Chinese', async ({ testWorkspace, workbench, restartWorkbench }) => {
		const cwd = testWorkspace.directory;
		const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await writeFile(join(cwd, 'new.ts'), 'untracked file\n');
		const head = await git('rev-parse', 'HEAD');
		const index = await git('ls-files', '--stage');
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const languages = workbench.page.locator('.ash-quick-pick');
		await languages.getByRole('combobox').fill('简体中文');
		await languages.getByRole('combobox').press('Enter');
		({ workbench } = await restartWorkbench());
		await workbench.git.open();
		const page = workbench.page;
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^提交信息/u });
		await editor.focus();
		await page.keyboard.insertText('中文提交草稿');
		await editor.press('Alt+F1');
		const help = page.getByRole('dialog').getByRole('textbox');
		await expect(help).toHaveValue(/询问是否包含未跟踪的文件/u);
		await expect(help).toHaveValue(/Git 身份添加 Signed-off-by 尾注/u);
		await expect(help).toHaveValue(/未编辑过的空草稿恢复完整提交信息/u);
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await workbench.quickaccess.runCommand('git.commitAllSigned');
		const scope = page.locator('.ash-quick-pick');
		await expect(scope.getByRole('option', { name: /^仅已跟踪的更改/u })).toBeVisible();
		await expect(scope.getByRole('option', { name: /^已跟踪和未跟踪的更改/u })).toBeVisible();
		await page.keyboard.press('Escape');
		expect(await git('rev-parse', 'HEAD')).toBe(head);
		expect(await git('ls-files', '--stage')).toBe(index);
		await expect(input.locator('.view-lines')).toContainText('中文提交草稿');
		await workbench.quickaccess.runCommand('git.commitAllSigned');
		await scope.getByRole('option', { name: /^仅已跟踪的更改/u }).click();
		await expect.poll(() => git('log', '-1', '--format=%s')).toBe('中文提交草稿');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 2;');
		expect(await git('log', '-1', '--format=%B')).toContain('Signed-off-by:');
		expect(await git('ls-files', 'new.ts')).toBe('');
		await expect(input.locator('.stanza-editor-placeholder-text')).toBeVisible();
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
