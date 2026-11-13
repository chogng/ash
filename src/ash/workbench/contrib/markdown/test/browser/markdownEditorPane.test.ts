import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Markdown editor pane', () => {
	const browser = useBrowserTests();
	const open = async () => {
		await browser.page.goto('/markdownEditorPane.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
	};
	const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

	test('Markdown document is optional and uses the same model as the code editor', async () => {
		await open();
		assert.deepEqual(await browser.page.evaluate(() => ({ defaultEditor: window.markdownPaneFixture.defaultEditor, shared: window.markdownPaneFixture.sharedModel, choices: window.markdownPaneFixture.choices })), {
			defaultEditor: 'stanza.editor.code', shared: true, choices: ['stanza.editor.code', 'ash.editor.markdown'],
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
		assert.equal(await browser.page.evaluate(() => window.markdownPaneFixture.text), '# Shared\n\noriginal中文🙂');
		assert.equal(await browser.page.evaluate(() => window.markdownPaneFixture.dirty), true);
		await browser.page.evaluate(() => window.markdownPaneFixture.reopen());
		await expect(body).toContainText('original中文🙂');
		assert.equal(await browser.page.evaluate(() => window.markdownPaneFixture.sharedModel), true);
		await browser.page.evaluate(() => window.markdownPaneFixture.save());
		assert.equal(await browser.page.evaluate(() => window.markdownPaneFixture.saved), '# Shared\n\noriginal中文🙂');
		assert.equal(await browser.page.evaluate(() => window.markdownPaneFixture.dirty), false);
	});
});
