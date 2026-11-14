import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Arkdown editor pane', () => {
	const browser = useBrowserTests();
	const open = async () => {
		await browser.page.goto('/arkdownEditorPane.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
	};
	const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

	test('Chinese accessibility help documents structural editing and table navigation', async () => {
		await browser.page.goto('/arkdownEditorPane.html?locale=zh-CN');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		const help = await browser.page.evaluate(() => window.arkdownPaneFixture.help.join(' '));
		assert.ok(help.includes('有序列表') && help.includes('Shift+Tab') && help.includes('新增一行') && help.includes('断线编辑') && help.includes('撤销本地编辑'));
		assert.ok(help.includes('自动保存') && help.includes('独立副本'));
		assert.ok(help.includes('切换标签页') && help.includes('256') && help.includes('释放此前历史'));
		await expect(browser.page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
	});

	test('Arkdown is a document host and does not register for ordinary Markdown files', async () => {
		await open();
		assert.deepEqual(await browser.page.evaluate(() => ({ defaultEditor: window.arkdownPaneFixture.defaultEditor, shared: window.arkdownPaneFixture.sharedModel, choices: window.arkdownPaneFixture.choices })), {
			defaultEditor: 'stanza.editor.code', shared: true, choices: ['stanza.editor.code'],
		});
	});

	test('rich and code editing share undo, dirty, save and pane reopening', async () => {
		await open();
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press(end); await body.pressSequentially('中文🙂');
		const source = browser.page.getByRole('textbox', { name: 'Peer Markdown source', exact: true });
		await source.press(end); await source.pressSequentially(' code');
		await expect(body).toContainText('original中文🙂 code');
		await source.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownPaneFixture.text), '# Shared\n\noriginal中文🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownPaneFixture.dirty), true);
		await browser.page.evaluate(() => window.arkdownPaneFixture.reopen());
		await expect(body).toContainText('original中文🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownPaneFixture.sharedModel), true);
		await browser.page.evaluate(() => window.arkdownPaneFixture.save());
		assert.equal(await browser.page.evaluate(() => window.arkdownPaneFixture.saved), '# Shared\n\noriginal中文🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownPaneFixture.dirty), false);
	});
});
