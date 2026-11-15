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

	test('toolbar inserts whole blocks and structural edits share document undo', async () => {
		await mount('alpha beta');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('p').click();
		await browser.page.evaluate(() => window.arkdownFixture.insertBlock('| A | B |\n| --- | --- |\n|  |  |'));
		await expect(body.locator('table')).toBeVisible();
		assert.ok((await browser.page.evaluate(() => window.arkdownFixture.source)).startsWith('alpha beta\n\n| A | B |'));
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'alpha beta');
		await body.locator('p').click();
		await browser.page.evaluate(() => window.arkdownFixture.setHeading(2));
		await expect(body.locator('h2')).toHaveText('alpha beta');
		await body.press('ControlOrMeta+z');
		await browser.page.evaluate(() => window.arkdownFixture.setListKind('task'));
		await expect(body.getByRole('img', { name: 'Incomplete task' })).toBeVisible();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.list), 'task');
	});

	test('dropdown selection persists in source, supports undo and remains safe and read-only', async () => {
		const source = '```ash-dropdown\n{"label":"Status","options":["Todo","<script>Done</script>"],"selected":0}\n```\n\n';
		await mount(source);
		const select = browser.page.getByRole('combobox', { name: 'Status', exact: true });
		await expect(select).toHaveValue('Todo');
		await select.selectOption({ label: '<script>Done</script>' });
		await expect(select).toHaveValue('<script>Done</script>');
		assert.ok((await browser.page.evaluate(() => window.arkdownFixture.source)).includes('"selected":1'));
		assert.equal(await browser.page.locator('.stanza-arkdown-prose script').count(), 0);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'Status: <script>Done</script>');
		await browser.page.getByRole('textbox', { name: 'Document body', exact: true }).press('ControlOrMeta+z');
		await expect(select).toHaveValue('Todo');
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		await expect(select).toBeDisabled();
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(false));
		await expect(select).toBeEnabled();
		await mount('```ash-dropdown\n{"selected":99}\n```');
		await expect(browser.page.getByRole('combobox')).toHaveCount(0);
		await expect(browser.page.locator('pre')).toContainText('selected');
	});
	test('retained collaboration highlights stay isolated after reloading editors', async () => {
		await mount('Foreground content');
		const initialRules = await browser.page.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.cssText.includes('::highlight(arkdown-')).length);
		for (let round = 0; round < 2; round++) {
			await browser.page.evaluate(() => window.arkdownFixture.backgroundHighlights(56));
			const state = await browser.page.evaluate(() => {
				const names = [...CSS.highlights.keys()].filter(name => name.startsWith('arkdown-'));
				const foreground = document.querySelector('#root .stanza-arkdown-prose')!;
				for (const color of ['blue', 'purple', 'green', 'orange', 'red', 'yellow']) document.documentElement.style.setProperty(`--ash-charts-${color}`, '#0080ff');
				const highlighted = [...CSS.highlights.get(names[0])!][0].startContainer.parentElement!;
				return {
					active: names.length,
					ranges: names.reduce((total, name) => total + CSS.highlights.get(name)!.size, 0),
					foregroundRanges: names.flatMap(name => [...CSS.highlights.get(name)!]).filter(range => foreground.contains(range.startContainer)).length,
					rules: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.cssText.includes('::highlight(arkdown-')).length,
					outsideColors: [...new Set(names.map(name => getComputedStyle(document.body, `::highlight(${name})`).backgroundColor))],
					insideColor: getComputedStyle(highlighted, `::highlight(${names[0]})`).backgroundColor,
				};
			});
			assert.equal(state.active, 6);
			assert.equal(state.ranges, 336);
			assert.equal(state.foregroundRanges, 0);
			assert.equal(state.rules, initialRules);
			assert.deepEqual(state.outsideColors, ['rgba(0, 0, 0, 0)']);
			assert.notEqual(state.insideColor, 'rgba(0, 0, 0, 0)');
			await browser.page.evaluate(() => window.arkdownFixture.closeBackgroundEditor());
			assert.deepEqual(await browser.page.evaluate(() => {
				const highlights = [...CSS.highlights].filter(([name]) => name.startsWith('arkdown-'));
				return { colors: highlights.length, ranges: highlights.reduce((total, [, highlight]) => total + highlight.size, 0) };
			}), { colors: 6, ranges: 330 });
		}
		await browser.page.evaluate(() => window.arkdownFixture.backgroundHighlights(0));
		assert.equal(await browser.page.evaluate(() => [...CSS.highlights.keys()].filter(name => name.startsWith('arkdown-')).length), 0);
	});

	test('document input and selection use the owning browsing context', async () => {
		await browser.page.goto('/arkdown.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await browser.page.evaluate(() => window.arkdownFixture.mount('Child window', 'rich', true));
		const body = browser.page.frameLocator('iframe[title="Document window"]').getByRole('textbox', { name: 'Document body', exact: true });
		await body.press(documentEnd);
		await browser.page.keyboard.insertText(' content');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'Child window content');
		await body.press('ControlOrMeta+z');
		await expect(body).toHaveText('Child window');
		await body.locator('p').evaluate(async element => {
			const document = element.ownerDocument;
			const changed = new Promise<void>(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
			document.getSelection()!.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 5);
			await changed;
		});
		await browser.page.frameLocator('iframe[title="Document window"]').getByRole('button', { name: 'Outside document' }).focus();
		await browser.page.getByRole('button', { name: 'Bold', exact: true }).click();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '**Child** window');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

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

	test('interior edits retain unchanged block DOM and update selection maps', async () => {
		await mount('# Before\n\nalpha beta\n\n# Tail🙂');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		const retained = await body.locator('h1').last().elementHandle();
		await body.locator('p').click();
		await body.locator('p').evaluate(element => element.ownerDocument.getSelection()!.setPosition(element.firstChild, 2));
		await browser.page.keyboard.insertText('中文');
		await expect(body.locator('p')).toHaveText('al中文pha beta');
		assert.equal(await retained!.evaluate(element => element.isConnected), true);
		await body.locator('h1').last().click();
		await body.press(documentEnd);
		await browser.page.keyboard.insertText(' end');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '# Before\n\nal中文pha beta\n\n# Tail🙂 end');
		await body.press('ControlOrMeta+z');
		await expect(body.locator('h1').last()).toHaveText('Tail🙂');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('structural shortcuts use the shared source and undo history', async () => {
		await mount('中文🙂');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press('ControlOrMeta+Alt+2');
		await expect(body.locator('h2')).toHaveText('中文🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '## 中文🙂');
		await body.press('ControlOrMeta+z');
		await expect(body.locator('p')).toHaveText('中文🙂');
		await body.press('ControlOrMeta+Shift+9');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- [ ] 中文🙂');
		await expect(body.locator('li')).toHaveText('☐ 中文🙂');
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '中文🙂');
	});

	test('table Tab appends one editable row and Shift Tab moves backwards', async () => {
		const original = '| a | b |\n| - | - |\n| c | d |';
		await mount(original);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('td').last().click();
		await browser.page.keyboard.press('Tab');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original + '\n|   |   |\n');
		await browser.page.keyboard.insertText('新');
		await expect(body.locator('tr').last().locator('td').first()).toHaveText('新');
		await browser.page.keyboard.press('Shift+Tab');
		await browser.page.keyboard.insertText('前');
		await expect(body.locator('tr').nth(1).locator('td').last()).toContainText('前');
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
