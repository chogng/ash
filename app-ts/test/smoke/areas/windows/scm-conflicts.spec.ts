import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true, gitMergeConflict: true });

test('SCM opens a three-way merge editor and stages the saved manual resolution', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const open = page.getByRole('button', { name: 'Open merge conflict in main.ts' });
	await expect(open).toBeEnabled();
	await open.click();

	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.first()).toContainText('main.ts');
	await expect(group.content.locator('.ash-merge-inputs')).toBeVisible();
	await expect(group.content.locator('.ash-merge-input .stanza-editor')).toHaveCount(3);
	await expect(group.content.locator('.ash-merge-inline-actions')).toHaveCount(3);
	await expect(group.content.locator('.ash-merge-input-current .ash-merge-inline-inserted')).toBeVisible();
	await expect(group.content.getByRole('heading', { name: 'Base' })).toBeHidden();
	await expect(group.content.getByRole('heading', { name: 'Current' })).toBeVisible();
	await expect(group.content.getByRole('heading', { name: 'Incoming' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Base' }).click();
	await expect(group.content.getByRole('heading', { name: 'Base' })).toBeVisible();
	await expect(group.content.locator('.ash-merge-inline-actions')).toHaveCount(4);
	await page.getByRole('button', { name: 'Use Columns' }).click();
	const columnPositions = await Promise.all(['.ash-merge-input-current', '.ash-merge-result', '.ash-merge-input-incoming'].map(selector => group.content.locator(selector).evaluate(node => node.getBoundingClientRect().left)));
	expect(columnPositions[0]).toBeLessThan(columnPositions[1]);
	expect(columnPositions[1]).toBeLessThan(columnPositions[2]);
	await page.getByRole('button', { name: 'Use Stacked Layout' }).click();
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
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(page.locator('.ash-merge-hunk')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Next Conflict' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Next Unresolved' })).toBeEnabled();
	await page.getByRole('button', { name: 'Accept Incoming' }).click();
	await expect(page.locator('.ash-merge-result-editor')).toContainText('const value = 2;');
	await expect(page.locator('.ash-merge-result-editor')).not.toContainText('<<<<<<<');
	await expect(page.locator('.ash-merge-hunk')).toHaveCount(1);
	await expect(page.locator('.ash-merge-hunk-state')).toHaveText('Incoming accepted');
	await expect(page.getByRole('button', { name: 'Next Unresolved' })).toBeDisabled();
	await expect(page.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
	await expect(page.getByRole('button', { name: 'Accept Incoming' })).toBeFocused();
	await page.getByRole('button', { name: 'Complete Merge' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	expect((await readFile(testWorkspace.file, 'utf8'))).toBe('const value = 2;\n');
	expect((await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('const value = 2;\n');
});

test('SCM can choose the incoming-first combination and then use the common ancestor', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await page.getByRole('button', { name: 'Accept Both (Incoming First)' }).click();
	await expect(page.locator('.ash-merge-hunk-state')).toHaveText('Both accepted, incoming first');
	await expect(page.locator('.ash-merge-result-editor')).toContainText('const value = 2;');
	await expect(page.locator('.ash-merge-result-editor')).toContainText('const value = 3;');
	await page.getByRole('button', { name: 'Use Base' }).click();
	await expect(page.locator('.ash-merge-hunk-state')).toHaveText('Base');
	await expect(page.locator('.ash-merge-result-editor')).toContainText('const value = 1;');
	await expect(page.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
});

test('SCM keeps an explicitly handled base result when the merge editor reopens', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	await writeFile(testWorkspace.file, 'const value = 1;\n');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	const group = workbench.editors.groupAt(0);
	await expect(group.content.locator('.ash-merge-hunk-state')).toHaveText('Unresolved');
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('0 of 1 conflicts resolved');
	await page.getByRole('button', { name: 'Complete Merge' }).click();
	await expect(group.content.locator('.ash-scm-merge-status')).toHaveText('Review or resolve every conflict before completing the merge.');
	await page.getByRole('button', { name: 'Use Base' }).click();
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
	await page.keyboard.press('F1');
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Close Editor');
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^Close Editor$/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(group.content.locator('.ash-merge-hunk-state')).toHaveText('Base');
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
	await page.getByRole('button', { name: 'Complete Merge' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
});

test('SCM requires review of an existing manual result and preserves the decision', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	await writeFile(testWorkspace.file, 'const reviewed = true;\n');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	const group = workbench.editors.groupAt(0);
	await expect(group.content.locator('.ash-merge-hunk-state')).toHaveText('Unresolved');
	await page.getByRole('button', { name: 'Mark Handled' }).click();
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
	await page.getByRole('button', { name: 'Mark Unhandled' }).click();
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('0 of 1 conflicts resolved');
	await page.getByRole('button', { name: 'Mark Handled' }).click();
	await page.keyboard.press('F1');
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Close Editor');
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^Close Editor$/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(group.content.locator('.ash-merge-hunk-state')).toHaveText('Manual resolution');
	await page.getByRole('button', { name: 'Complete Merge' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
});

test('SCM preserves a manually edited result after saving and reopening', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	const group = workbench.editors.groupAt(0);
	const input = group.content.locator('.ash-merge-result-editor .stanza-editor-input');
	await input.focus();
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	await input.type('const reviewed = true;\n');
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const reviewed = true;\n');
	await page.keyboard.press('F1');
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('Close Editor');
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^Close Editor$/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(group.content.locator('.ash-merge-hunk-state')).toHaveText('Manual resolution');
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 1 conflicts resolved');
});

test('SCM merge editors synchronize scrolling across the three sources and result', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const cwd = testWorkspace.directory;
	await run('git', ['merge', '--abort'], { cwd });
	await run('git', ['reset', '--hard', 'HEAD~1'], { cwd });
	const lines = Array.from({ length: 150 }, (_, index) => `const line${index} = ${index};`);
	lines[74] = `const preceding = '${'wide'.repeat(70)}';`;
	lines[75] = 'const value = 1;';
	lines[76] = 'const middle = 1;';
	lines[77] = 'const tail = 1;';
	lines[125] = 'const second = 1;';
	await writeFile(testWorkspace.file, `${lines.join('\n')}\n`);
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Long base'], { cwd });
	await run('git', ['branch', '-f', 'topic', 'HEAD'], { cwd });
	await run('git', ['switch', 'topic'], { cwd });
	const incomingLines = [...lines];
	incomingLines.splice(75, 3, 'const value = 2;', 'const middle = 2;', 'const tail = 1;');
	incomingLines[125] = 'const second = 2;';
	await writeFile(testWorkspace.file, `${incomingLines.join('\n')}\n`);
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Long topic'], { cwd });
	await run('git', ['switch', 'main'], { cwd });
	const currentLines = [...lines];
	currentLines.splice(75, 3, 'const value = 3;', 'const currentExtra = 30;', 'const middle = 1;', 'const tail = 3;');
	currentLines[126] = 'const second = 3;';
	await writeFile(testWorkspace.file, `${currentLines.join('\n')}\n`);
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Long main'], { cwd });
	await run('git', ['merge', 'topic'], { cwd }).then(() => { throw new Error('Expected text conflict'); }, () => undefined);

	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	const group = workbench.editors.groupAt(0);
	await expect(group.content.locator('.ash-merge-hunk')).toHaveCount(2);
	const editors = ['current', 'incoming'].map(side => group.content.locator(`.ash-merge-input-${side} .stanza-editor`));
	editors.push(group.content.locator('.ash-merge-result-editor .stanza-editor'));
	for (const editor of editors) {
		await expect(editor).toBeVisible();
		expect(await editor.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(0);
	}
	await editors[0].locator(':scope > .ash-smooth-scrollable').evaluate(node => { node.scrollTop = 600; node.dispatchEvent(new Event('scroll')); });
	await expect.poll(async () => Promise.all(editors.map(editor => editor.locator(':scope > .ash-smooth-scrollable').evaluate(node => node.scrollTop)))).toEqual([600, 600, 600]);
	await page.getByRole('button', { name: 'Show Base' }).click();
	const baseEditor = group.content.locator('.ash-merge-input-base .stanza-editor');
	await expect(baseEditor).toBeVisible();
	await expect.poll(async () => baseEditor.locator(':scope > .ash-smooth-scrollable').evaluate(node => node.scrollTop)).toBe(600);
	await page.getByRole('button', { name: 'Conflict 1' }).click();
	const alignedTops = await Promise.all(['.ash-merge-input-base', '.ash-merge-input-current', '.ash-merge-input-incoming', '.ash-merge-result-editor'].map(selector => group.content.locator(`${selector} .ash-merge-inline-actions[data-visible-view-zone]`).evaluate(node => {
		const editor = node.closest('.stanza-editor')!;
		return node.getBoundingClientRect().top - editor.getBoundingClientRect().top;
	})));
	expect(Math.max(...alignedTops) - Math.min(...alignedTops)).toBeLessThan(2);
	const pairedLines = [
		['base', 'const middle = 1;'],
		['current', 'const middle = 1;'],
		['incoming', 'const middle = 2;'],
	] as const;
	const pairedTops = await Promise.all(pairedLines.map(([side, content]) => group.content.locator(`.ash-merge-input-${side} .view-line`, { hasText: content }).evaluate(node => {
		const editor = node.closest('.stanza-editor')!;
		return node.getBoundingClientRect().top - editor.getBoundingClientRect().top;
	})));
	expect(Math.max(...pairedTops) - Math.min(...pairedTops)).toBeLessThan(2);
	const readActionTopSpread = async (): Promise<number> => {
		const tops = await Promise.all(['.ash-merge-input-base', '.ash-merge-input-current', '.ash-merge-input-incoming', '.ash-merge-result-editor'].map(selector => group.content.locator(`${selector} .ash-merge-inline-actions[data-visible-view-zone]`).evaluate(node => {
			const editor = node.closest('.stanza-editor')!;
			return node.getBoundingClientRect().top - editor.getBoundingClientRect().top;
		})));
		return Math.max(...tops) - Math.min(...tops);
	};
	await group.content.locator('.ash-merge-result-editor .stanza-editor-input').focus();
	await page.keyboard.press('F1');
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('View: Toggle Word Wrap');
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^View: Toggle Word Wrap$/u }).click();
	await expect(group.content.locator('.ash-merge-result-editor .stanza-editor')).toHaveClass(/word-wrapped/);
	await page.getByRole('button', { name: 'Conflict 1' }).click();
	await expect.poll(readActionTopSpread).toBeLessThan(2);
	const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const resultWidth = await editors[2].evaluate(node => node.getBoundingClientRect().width);
	const currentAction = group.content.locator('.ash-merge-input-current .ash-merge-inline-actions[data-visible-view-zone]').getByRole('button', { name: 'Accept Current' });
	await currentAction.focus();
	await page.setViewportSize({ width: viewport.width - 300, height: viewport.height });
	await expect.poll(() => editors[2].evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(resultWidth - 100);
	await expect.poll(readActionTopSpread).toBeLessThan(2);
	await expect(currentAction).toBeFocused();
	await page.setViewportSize(viewport);
	const actionScrollTop = await editors[0].locator(':scope > .ash-smooth-scrollable').evaluate(node => node.scrollTop);
	await editors[0].locator(':scope > .ash-smooth-scrollable').evaluate(node => {
		const line = [...node.querySelectorAll('.view-line')].find(row => row.textContent?.includes('const currentExtra = 30;'));
		if (!line) throw new Error('Current conflict line is not rendered');
		node.scrollTop += line.getBoundingClientRect().top - node.getBoundingClientRect().top + 8;
		node.dispatchEvent(new Event('scroll'));
	});
	await expect.poll(async () => {
		const scrollTops = await Promise.all([...editors, baseEditor].map(editor => editor.locator(':scope > .ash-smooth-scrollable').evaluate(node => node.scrollTop)));
		return Math.max(...scrollTops) - Math.min(...scrollTops);
	}).toBeLessThan(2);
	await editors[0].locator(':scope > .ash-smooth-scrollable').evaluate((node, scrollTop) => {
		node.scrollTop = scrollTop;
		node.dispatchEvent(new Event('scroll'));
	}, actionScrollTop);
	await expect(group.content.locator('.ash-merge-input-current .ash-merge-inline-actions[data-visible-view-zone]')).toBeVisible();
	await group.content.locator('.ash-merge-input-current .ash-merge-inline-actions[data-visible-view-zone]').getByRole('button', { name: 'Accept Current' }).click();
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 2 conflicts resolved');
	await page.getByRole('button', { name: 'Conflict 1' }).click();
	const resolvedLines = await Promise.all([
		group.content.locator('.ash-merge-input-current .view-line', { hasText: 'const middle = 1;' }),
		group.content.locator('.ash-merge-result-editor .view-line', { hasText: 'const middle = 1;' }),
	].map(line => line.evaluate(node => {
		const editor = node.closest('.stanza-editor')!;
		return node.getBoundingClientRect().top - editor.getBoundingClientRect().top;
	})));
	expect(Math.abs(resolvedLines[0] - resolvedLines[1])).toBeLessThan(2);
	await page.getByRole('button', { name: 'Next Unresolved' }).click();
	await expect(group.content.locator('.ash-merge-hunk').nth(1)).toHaveClass(/active/);
	await expect(group.content.locator('.ash-merge-inline-actions[data-visible-view-zone]')).toHaveCount(4);
	expect(await group.content.locator('.ash-merge-input-current .ash-merge-spacer').count()).toBeGreaterThan(0);
	await page.getByRole('button', { name: 'Accept Remaining Incoming' }).click();
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('2 of 2 conflicts resolved');
	const resultInput = group.content.locator('.ash-merge-result-editor .stanza-editor-input');
	await resultInput.focus();
	await resultInput.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
	await expect(group.content.locator('.ash-merge-progress')).toHaveText('1 of 2 conflicts resolved');
});

test('SCM resolves a non-text result by choosing the whole current file', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	await writeFile(testWorkspace.file, Buffer.from([0, 1, 2, 3]));
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
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
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await page.getByRole('button', { name: 'Open merge conflict in main.ts' }).click();
	await expect(page.getByRole('button', { name: 'Keep Incoming Deletion' })).toBeVisible();
	await page.getByRole('button', { name: 'Keep Incoming Deletion' }).click();
	await expect(page.locator('.ash-scm-merge-status')).toHaveText('Merge completed and result staged.');
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	expect((await run('git', ['ls-files', '--stage', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
});
