import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);


test.describe('SCM welcome', () => {
	test.use({ openWorkspace: false });

	test('SCM welcome shows host actions and restores keyboard focus from help', async ({ target, workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
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

	test('SCM welcome wraps in a narrow pane and uses theme colors and keyboard focus', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
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

test('SCM welcome initializes a repository through the backend and returns to Changes', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const page = workbench.page;
	const originalContent = await readFile(testWorkspace.file, 'utf8');
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const changes = page.locator('[data-view-id="ash.gitView"]');
	await expect(page.locator('.ash-scm-viewlet [data-view-id]')).toHaveAttribute('data-view-id', 'ash.gitView');
	await expect(changes.locator('.ash-pane-view-header')).toBeHidden();
	await expect(changes.locator('.ash-scm-commit-form')).toBeHidden();
	await changes.getByRole('button', { name: 'Initialize Repository', exact: true }).click();
	await page.locator('.ash-quick-pick').getByRole('option').first().click();
	const branch = page.getByRole('dialog', { name: 'Initial branch name', exact: true }).getByRole('textbox', { name: 'Initial branch name', exact: true });
	await branch.fill('welcome-main');
	await branch.press('Enter');
	await expect.poll(() => run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: testWorkspace.directory }).then(result => result.stdout.trim(), () => undefined)).toBe('welcome-main');
	expect(await readFile(testWorkspace.file, 'utf8')).toBe(originalContent);
	await expect(changes.getByRole('region', { name: 'Welcome', exact: true })).toBeHidden();
	await expect(changes.locator('.ash-scm-commit-form')).toBeVisible();
	await expect(changes.locator('.ash-pane-view-header')).toBeVisible();
	await expect(page.locator('[data-view-id="ash.gitAgentReview"] .ash-pane-view-header')).toBeVisible();
	await expect(page.locator('[data-view-id="ash.gitGraph"] .ash-pane-view-header')).toBeVisible();
});

test.describe('SCM commit input', () => {
	test.use({ gitRepository: true });


	test('SCM commit input localizes scope and draft help after restarting in Chinese', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, workbench, restartWorkbench }) => {
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
		await expect(help).toHaveValue(/为当前源代码管理提供程序输入消息。Enter 插入新行/u);
		await expect(help).toHaveValue(/每个仓库保留各自的草稿/u);
		await expect(help).toHaveValue(/Escape 关闭帮助并返回消息输入框/u);
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

	test('SCM commits the edited message with Ctrl+Enter and clears the draft', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, workbench }) => {
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await run('git', ['add', 'main.ts'], { cwd: testWorkspace.directory });
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		await expect(page.locator('.ash-scm-commit')).toBeEnabled();
		await expect(input.locator('.stanza-editor-placeholder-text')).toHaveText(/^Message \(.+ to commit on "main"\)$/u);
		await editor.focus();
		await editor.press('Tab');
		await expect(page.locator('.ash-scm-commit')).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(editor).toBeFocused();
		await page.keyboard.insertText('SCM editor commit');
		await editor.press('Enter');
		await page.keyboard.insertText('Preserve the message body.');
		await editor.press('ControlOrMeta+Enter');
		await expect.poll(async () => (await run('git', ['log', '-1', '--format=%B'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('SCM editor commit\nPreserve the message body.');
		await expect(input.locator('.stanza-editor-placeholder-text')).toBeVisible();
		await expect.poll(() => input.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(26);
		await expect(editor).toBeFocused();
	});

	test('SCM keeps separate commit drafts when switching repositories', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, workbench }) => {
		const nested = join(testWorkspace.directory, 'nested');
		await mkdir(nested);
		await run('git', ['init', '-b', 'topic'], { cwd: nested });
		await writeFile(join(nested, 'nested.txt'), 'nested repository\n');
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
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
		await expect(input.locator('.stanza-editor-placeholder-text')).toHaveText(/^Message \(.+ to commit on "topic"\)$/u);
		await editor.focus();
		await page.keyboard.insertText('Topic draft');
		await primary.click();
		await expect(input.locator('.view-lines')).toContainText('Main draft');
		await secondary.click();
		await expect(input.locator('.view-lines')).toContainText('Topic draft');
	});
});
