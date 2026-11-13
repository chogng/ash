import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Arkdown document editing', () => {
	const browser = useBrowserTests();
	const documentEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
	const mount = async (source: string, mode: 'rich' | 'markdown' = 'rich') => {
		await browser.page.goto('/arkdown.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await browser.page.evaluate(({ source, mode }) => window.arkdownFixture.mount(source, mode), { source, mode });
	};

	test('direct editing preserves Markdown syntax, entities and shared undo', async () => {
		const original = '# Title\n\nA &amp; **bold** tail';
		await mount(original);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await expect(body.locator('h1')).toHaveText('Title');
		await expect(body.locator('strong')).toHaveText('bold');
		await body.press(documentEnd);
		await body.pressSequentially('中文🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original + '中文🙂');
		await body.press('Control+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original + '中文');
		await browser.page.evaluate(() => window.arkdownFixture.mode('markdown'));
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original + '中文');
		await expect(browser.page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeVisible();
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('formatted selection commits Markdown through the text model', async () => {
		await mount('plain text');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press('ControlOrMeta+a');
		await browser.page.getByRole('button', { name: 'Bold', exact: true }).click();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '**plain text**');
		await expect(body.locator('strong')).toHaveText('plain text');
		await body.press('Control+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'plain text');
	});

	test('formatting an empty document selects an editable format snippet', async () => {
		await mount('');
		await browser.page.getByRole('button', { name: 'Bold', exact: true }).click();
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await expect(body.locator('strong')).toHaveText('Bold');
		await body.pressSequentially('中文');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '**中文**');
	});

	test('typing retains terminal spaces before further input', async () => {
		await mount('');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.pressSequentially('first second  third ');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'first second  third ');
		await expect(body).toHaveText('first second  third ');
	});

	test('native word deletion changes the model without changing Markdown delimiters', async () => {
		await mount('# Title\n\nword next');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press(documentEnd);
		await body.press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '# Title\n\nword ');
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '# Title\n\nword next');
	});

	test('rich input preserves CRLF and deletes a whole grapheme', async () => {
		await mount('first\r\n\r\n👩‍👩‍👧‍👦');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press(documentEnd); await body.press('Backspace');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'first\r\n\r\n');
		await body.pressSequentially('second'); await body.press('Enter'); await body.pressSequentially('third');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'first\r\n\r\nsecond\r\n\r\nthird');
	});

	test('source mode uses CodeEditor input and the same undo history', async () => {
		await mount('old', 'markdown');
		const source = browser.page.getByRole('textbox', { name: 'Markdown source', exact: true });
		await source.press(documentEnd);
		await source.pressSequentially('中文🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'old中文🙂');
		await source.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'old');
		await browser.page.evaluate(() => window.arkdownFixture.mode('rich'));
		await expect(browser.page.getByRole('textbox', { name: 'Document body', exact: true })).toHaveText('old');
	});

	test('Enter creates an editable empty paragraph and does not move typing back', async () => {
		await mount('first');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press(documentEnd); await body.press('Enter'); await body.pressSequentially('second');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'first\n\nsecond');
	});

	test('source editing handles emoji replacement and preserves CRLF', async () => {
		await mount('# 中\r\n\r\n🙂 end', 'markdown');
		const source = browser.page.getByRole('textbox', { name: 'Markdown source', exact: true });
		await source.press('ControlOrMeta+a');
		await browser.page.keyboard.insertText('# 中\n\n🙃 end');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '# 中\r\n\r\n🙃 end');
		await source.press('Control+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '# 中\r\n\r\n🙂 end');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('plain text export uses formatted content even in source mode', async () => {
		await mount('# Heading\n\n**bold** &amp; _italic_\n\n- first\n- second', 'markdown');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'Heading\n\nbold & italic\n\nfirst\nsecond');
	});

	test('parser limits preserve an editable source and allow recovery', async () => {
		const original = 'paragraph\n\n'.repeat(50_001);
		await mount(original);
		const source = browser.page.getByRole('textbox', { name: 'Markdown source', exact: true });
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
		await expect(source).toBeVisible();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.errors.length), 1);
		await source.press('ControlOrMeta+a');
		await browser.page.keyboard.insertText('# Recovered');
		await browser.page.evaluate(() => window.arkdownFixture.mode('rich'));
		await expect(browser.page.getByRole('textbox', { name: 'Document body', exact: true }).locator('h1')).toHaveText('Recovered');
	});

	test('composition commits once, while an external update cancels a stale composition', async () => {
		await mount('old');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press(documentEnd);
		await body.evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
			element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromComposition', data: '中文', bubbles: true, cancelable: true }));
		});
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'old中文');
		await body.evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.textContent = 'provisional DOM';
			element.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
		});
		await expect(body).toHaveText('old中文');
		await body.evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			window.arkdownFixture.external('external');
			element.dispatchEvent(new CompositionEvent('compositionend', { data: 'stale', bubbles: true }));
		});
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'external');
		await expect(body).toHaveText('external');
	});

	test('read-only editing is blocked and raw HTML is displayed as text', async () => {
		const original = '<script>window.bad=1</script>\n\nbody';
		await mount(original);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		assert.equal(await body.locator('script').count(), 0);
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		await expect(body).toHaveAttribute('aria-readonly', 'true');
		await body.pressSequentially('blocked');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
		await browser.page.evaluate(() => window.arkdownFixture.mode('markdown'));
		const source = browser.page.getByRole('textbox', { name: 'Markdown source', exact: true });
		await expect(source).toHaveAttribute('aria-readonly', 'true');
		await source.pressSequentially('blocked');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
	});
});
