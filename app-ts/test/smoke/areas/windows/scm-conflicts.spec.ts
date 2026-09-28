import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true, gitMergeConflict: true });

test('SCM opens a three-way merge editor and stages the saved manual resolution', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const open = page.getByRole('button', { name: 'Open merge conflict in main.ts' });
	await expect(open).toBeEnabled();
	await open.click();

	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.first()).toContainText('main.ts');
	await expect(group.content.locator('.ash-merge-inputs')).toBeVisible();
	await expect(group.content.locator('.ash-merge-input .stanza-editor')).toHaveCount(3);
	await expect(group.content.getByRole('heading', { name: 'Base' })).toBeVisible();
	await expect(group.content.getByRole('heading', { name: 'Current' })).toBeVisible();
	await expect(group.content.getByRole('heading', { name: 'Incoming' })).toBeVisible();
	const currentSection = group.content.locator('.ash-merge-input-current');
	const currentContent = await currentSection.textContent();
	const currentInput = group.content.locator('.ash-merge-input-current .stanza-editor-input');
	await currentInput.focus();
	await currentInput.type('should not edit this side');
	await expect(currentSection).toHaveText(currentContent ?? '');
	const input = group.content.locator('.ash-merge-result-editor .stanza-editor-input');
	await expect(input).toBeAttached();
	await input.focus();
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	await input.type('const resolved = true;\n');
	const stage = page.getByRole('button', { name: 'Stage main.ts' });
	await stage.click();
	await expect(page.locator('.ash-scm-status')).toHaveText('Save main.ts before staging its conflict resolution.');
	expect((await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout.trim()).not.toBe('');
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const resolved = true;\n');

	await stage.click();
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	await expect(page.getByRole('button', { name: 'Open merge conflict in main.ts' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open staged changes for main.ts' })).toBeVisible();
	expect((await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('const resolved = true;\n');
});

test('SCM accepts an incoming conflict block and completes the merge', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(page.locator('.ash-merge-hunk')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Next Conflict' })).toBeEnabled();
	await page.getByRole('button', { name: 'Accept Incoming' }).click();
	await expect(page.locator('.ash-merge-hunk')).toHaveCount(1);
	await expect(page.locator('.ash-merge-hunk-state')).toHaveText('Resolved');
	await expect(page.getByRole('button', { name: 'Accept Incoming' })).toBeFocused();
	await page.getByRole('button', { name: 'Complete Merge' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	expect((await readFile(testWorkspace.file, 'utf8'))).toBe('const value = 2;\n');
	expect((await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('const value = 2;\n');
});

test('SCM merge editors synchronize scrolling across the three sources and result', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const cwd = testWorkspace.directory;
	await run('git', ['merge', '--abort'], { cwd });
	await run('git', ['reset', '--hard', 'HEAD~1'], { cwd });
	const lines = Array.from({ length: 150 }, (_, index) => `const line${index} = ${index};`);
	lines[75] = 'const value = 1;';
	await writeFile(testWorkspace.file, `${lines.join('\n')}\n`);
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Long base'], { cwd });
	await run('git', ['branch', '-f', 'topic', 'HEAD'], { cwd });
	await run('git', ['switch', 'topic'], { cwd });
	lines[75] = 'const value = 2;';
	await writeFile(testWorkspace.file, `${lines.join('\n')}\n`);
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Long topic'], { cwd });
	await run('git', ['switch', 'main'], { cwd });
	lines[75] = 'const value = 3;';
	await writeFile(testWorkspace.file, `${lines.join('\n')}\n`);
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Long main'], { cwd });
	await run('git', ['merge', 'topic'], { cwd }).then(() => { throw new Error('Expected text conflict'); }, () => undefined);

	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	const group = workbench.editors.groupAt(0);
	const editors = ['base', 'current', 'incoming'].map(side => group.content.locator(`.ash-merge-input-${side} .stanza-editor`));
	editors.push(group.content.locator('.ash-merge-result-editor .stanza-editor'));
	for (const editor of editors) {
		await expect(editor).toBeVisible();
		expect(await editor.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(0);
	}
	await editors[1].evaluate(node => { node.scrollTop = 600; node.dispatchEvent(new Event('scroll')); });
	await expect.poll(async () => Promise.all(editors.map(editor => editor.evaluate(node => node.scrollTop)))).toEqual([600, 600, 600, 600]);
});

test('SCM resolves a non-text result by choosing the whole current file', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	await writeFile(testWorkspace.file, Buffer.from([0, 1, 2, 3]));
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(page.getByRole('button', { name: 'Use Current File' })).toBeVisible();
	await page.getByRole('button', { name: 'Use Current File' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	expect((await readFile(testWorkspace.file, 'utf8'))).toBe('const value = 3;\n');
	expect((await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('const value = 3;\n');
});

test('SCM can keep a deleted side of a modify/delete conflict', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	await run('git', ['merge', '--abort'], { cwd: testWorkspace.directory });
	await run('git', ['switch', 'topic'], { cwd: testWorkspace.directory });
	await run('git', ['rm', 'main.ts'], { cwd: testWorkspace.directory });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Delete file'], { cwd: testWorkspace.directory });
	await run('git', ['switch', 'main'], { cwd: testWorkspace.directory });
	await run('git', ['merge', 'topic'], { cwd: testWorkspace.directory }).then(() => { throw new Error('Expected modify/delete conflict'); }, () => undefined);
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(page.getByRole('button', { name: 'Keep Incoming Deletion' })).toBeVisible();
	await page.getByRole('button', { name: 'Keep Incoming Deletion' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	expect((await run('git', ['ls-files', '--stage', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
});
