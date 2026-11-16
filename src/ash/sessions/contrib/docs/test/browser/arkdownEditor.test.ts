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

	test('select all replaces leading and trailing atomic content and Markdown block syntax', async () => {
		await browser.page.route('https://docs-assets.test/**', route => route.abort());
		const dropdown = '```ash-dropdown\n{"label":"Status","options":["Todo","Done"],"selected":0}\n```';
		const image = '![Logo](https://docs-assets.test/logo.png)';
		for (const source of [dropdown, image, '# Heading\n\n- [ ] Task', `${dropdown}\n\n${image}\n\n# Heading\n\nBody **text**`, `Text\n\n${dropdown}\n\n${image}`]) {
			await mount(source);
			const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
			if (source === dropdown) await body.getByRole('combobox').press('ControlOrMeta+a');
			else await body.press('ControlOrMeta+a');
			await browser.page.keyboard.insertText('Replacement');
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'Replacement', source);
			await expect(body.locator('select, img, h1, li')).toHaveCount(0);
			await body.press('ControlOrMeta+z');
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), source);
		}
	});

	test('select all paste replaces a mixed document including its first dropdown and image', async () => {
		await browser.page.route('https://docs-assets.test/**', route => route.abort());
		await mount('```ash-dropdown\n{"label":"状态","options":["待办","完成"],"selected":1}\n```\n\n![图](https://docs-assets.test/logo.png)\n\nLast **text**');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press('ControlOrMeta+a');
		await body.evaluate(element => {
			const data = new DataTransfer(); data.setData('text/plain', '粘贴 replacement🙂');
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
		});
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '粘贴 replacement🙂');
		await expect(body.locator('select, img')).toHaveCount(0);
	});

	test('a selection spanning task rows retains checklist formatting and exact text endpoints', async () => {
		await mount('- [ ] 审阅视觉方向\n- [ ] 邀请试用成员\n- [ ] 发布更新说明\n\n## 日程');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('.ash-arkdown-task-content > p').nth(1).evaluate(element => {
			const last = element.closest('ul')!.querySelectorAll('.ash-arkdown-task-content > p')[2];
			element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 3, last.firstChild!, 6);
		});
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.list), 'task');
		const bounds = await browser.page.evaluate(() => window.arkdownFixture.selectionBounds);
		const lastText = await body.locator('.ash-arkdown-task-content > p').nth(2).evaluate(element => {
			const range = element.ownerDocument.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect().toJSON();
		});
		assert.ok(bounds && bounds.left >= lastText.left && bounds.right <= lastText.right + 1 && bounds.bottom <= lastText.bottom + 1);
		await body.press('Backspace');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- [ ] 审阅视觉方向\n- [ ] 邀请试\n\n## 日程');
	});

	test('page width changes only the view and persists across source mode round trips', async () => {
		await mount('A paragraph with a constrained reading width.');
		await browser.page.evaluate(() => { document.getElementById('root')!.style.width = '1200px'; });
		const paragraph = browser.page.getByRole('textbox', { name: 'Document body', exact: true }).locator('p');
		const narrow = (await paragraph.boundingBox())!.width;
		await browser.page.evaluate(() => window.arkdownFixture.togglePageWidth());
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.isPageWide), true);
		assert.ok((await paragraph.boundingBox())!.width > narrow + 200);
		await browser.page.evaluate(() => { window.arkdownFixture.mode('markdown'); window.arkdownFixture.mode('rich'); });
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.isPageWide), true);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'A paragraph with a constrained reading width.');
		await browser.page.evaluate(() => window.arkdownFixture.togglePageWidth());
		assert.equal((await paragraph.boundingBox())!.width, narrow);
	});

	test('inline colors, underline and highlight preserve nested marks, partial clearing and undo', async () => {
		await mount('alpha **beta** gamma');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('strong').evaluate(element => element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 4));
		await browser.page.evaluate(() => window.arkdownFixture.setTextColor('red'));
		await expect(body.locator('strong .ash-arkdown-text-red')).toHaveText('beta');
		await browser.page.evaluate(() => window.arkdownFixture.toggleUnderline());
		await browser.page.evaluate(() => window.arkdownFixture.setHighlight(true));
		await expect(body.locator('u mark')).toHaveText('beta');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.textColor), 'red');
		await browser.page.evaluate(() => window.arkdownFixture.setTextColor('purple'));
		await expect(body.locator('.ash-arkdown-text-red')).toHaveCount(0);
		const purple = body.locator('.ash-arkdown-text-purple');
		await expect(purple).toHaveText('beta');
		await purple.evaluate(element => element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 1, element.firstChild!, 3));
		await browser.page.evaluate(() => window.arkdownFixture.setTextColor(undefined));
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), 'et');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.textColor), undefined);
		await expect(body.locator('.ash-arkdown-text-purple')).toHaveText(['b', 'a']);
		await browser.page.evaluate(() => window.arkdownFixture.toggleUnderline());
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.underline), false);
		await browser.page.evaluate(() => window.arkdownFixture.setHighlight(false));
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.highlight), false);
		await body.locator('strong').evaluate(element => {
			const range = element.ownerDocument.createRange();
			range.selectNodeContents(element);
			const selection = element.ownerDocument.getSelection()!;
			selection.removeAllRanges(); selection.addRange(range);
		});
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.mixedHighlight), true);
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.highlight), true);
		await browser.page.evaluate(() => window.arkdownFixture.mode('markdown'));
		await browser.page.evaluate(() => window.arkdownFixture.mode('rich'));
		await expect(body.locator('strong')).toHaveText('beta');
		const saved = await browser.page.evaluate(() => window.arkdownFixture.source);
		await browser.page.evaluate(() => { window.arkdownFixture.readOnly(true); window.arkdownFixture.setTextColor('green'); });
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), saved);
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('inline palette formatting keeps link destinations and Markdown code syntax', async () => {
		await mount('[Read **docs**](https://example.com) and `code`');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('a').evaluate(element => {
			const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
			const selection = element.ownerDocument.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		});
		await browser.page.evaluate(() => window.arkdownFixture.setTextColor('green'));
		await browser.page.evaluate(() => window.arkdownFixture.setHighlight(true));
		await expect(body.locator('a')).toHaveAttribute('data-href', 'https://example.com');
		await expect(body.locator('a')).toHaveText('Read docs');
		await expect(body.locator('strong')).toHaveText('docs');
		await expect(body.locator('code')).toHaveText('code');
		assert.ok((await browser.page.evaluate(() => window.arkdownFixture.source)).endsWith(' and `code`'));
	});

	test('multiblock formatting preserves Markdown blocks and arbitrary HTML stays inert', async () => {
		await mount('First **paragraph**\r\n\r\nSecond 中文🙂\r\n');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press('ControlOrMeta+a');
		await browser.page.evaluate(() => window.arkdownFixture.setTextColor('teal'));
		await expect(body.locator('p')).toHaveCount(2);
		await expect(body.locator('strong')).toHaveText('paragraph');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'First paragraph\n\nSecond 中文🙂');
		assert.ok((await browser.page.evaluate(() => window.arkdownFixture.source)).includes('\r\n\r\n'));
		await body.press('ControlOrMeta+z');
		await expect(body.locator('.ash-arkdown-text-teal')).toHaveCount(0);
		await mount('<span data-text-color="red" onclick="bad()">unsafe</span>\n\n<script>bad()</script>');
		await expect(body.locator('script, [onclick], .ash-arkdown-text-red')).toHaveCount(0);
	});

	test('Tab and Shift Tab indent selected list subtrees and retain selection and history', async () => {
		const original = '- Parent\r\n- Child🙂\r\n  - Nested\r\n- Last\r\n';
		await mount(original);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator(':scope > ul > li').nth(1).evaluate(element => element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 'Child🙂'.length));
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.canIndent('increase')), true);
		await body.press('Tab');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- Parent\r\n  - Child🙂\r\n    - Nested\r\n- Last\r\n');
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), 'Child🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.canIndent('decrease')), true);
		await body.press('Shift+Tab');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
		await body.press('ControlOrMeta+z');
		assert.ok((await browser.page.evaluate(() => window.arkdownFixture.source)).includes('  - Child🙂'));
	});

	test('selection formats retain the selected text and toggle through model undo', async () => {
		await mount('选中文字 alpha');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.press('ControlOrMeta+a');
		await browser.page.evaluate(() => window.arkdownFixture.format('~~'));
		await expect(body.locator('s')).toHaveText('选中文字 alpha');
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), '选中文字 alpha');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.strikethrough), true);
		await browser.page.evaluate(() => window.arkdownFixture.format('~~'));
		await expect(body.locator('s')).toHaveCount(0);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '选中文字 alpha');
		await body.press('ControlOrMeta+z');
		await expect(body.locator('s')).toHaveText('选中文字 alpha');
	});

	test('inline code handles backticks and selection geometry respects editing state', async () => {
		await mount('alpha \\` beta');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.selectionBounds), undefined);
		await body.press('ControlOrMeta+a');
		assert.ok(await browser.page.evaluate(() => window.arkdownFixture.selectionBounds?.width > 0));
		await browser.page.evaluate(() => window.arkdownFixture.format('`'));
		await expect(body.locator('code')).toHaveText('alpha ` beta');
		await browser.page.evaluate(() => window.arkdownFixture.format('`'));
		await expect(body.locator('code')).toHaveCount(0);
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), 'alpha ` beta');
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.selectionBounds), undefined);
		await browser.page.evaluate(() => window.arkdownFixture.mode('markdown'));
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.selectionBounds), undefined);
	});

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
		await expect(body.getByRole('checkbox', { name: 'Task: alpha beta' })).toBeVisible();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.formatting.list), 'task');
	});

	test('Setext and nested headings convert through rich editing and document history', async () => {
		const source = '> 中文 **标题**\r\n> 第二行🙂\r\n> ----\r\n\r\nTail';
		await mount(source);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('h2').evaluate(element => {
			const text = element.firstChild!;
			element.ownerDocument.getSelection()!.setBaseAndExtent(text, 0, text, 2);
		});
		await body.press('ControlOrMeta+Alt+Digit3');
		await expect(body.locator('blockquote h3')).toHaveText('中文 标题 第二行🙂');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '> ### 中文 **标题** 第二行🙂\r\n\r\nTail');
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), '中文');
		await body.press('ControlOrMeta+z');
		await expect(body.locator('blockquote h2')).toBeVisible();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), source);
		await browser.page.evaluate(() => window.arkdownFixture.setHeading(0));
		await expect(body.locator('blockquote p')).toHaveText('中文 标题 第二行🙂');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('nested list conversion keeps descendants, checked state and selection', async () => {
		const source = '- Parent\r\n  - [x] Child🙂\r\n    - Grandchild\r\n  - [ ] Next\r\n- Tail\r\n';
		await mount(source);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('.ash-arkdown-task-content p').first().evaluate(element => {
			element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 5);
		});
		await body.press('ControlOrMeta+Shift+Digit7');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- Parent\r\n  1. Child🙂\r\n     - Grandchild\r\n  2. Next\r\n- Tail\r\n');
		await expect(body.locator('ul > li > ol')).toHaveCount(1);
		await expect(body.locator('ol > li > ul')).toHaveText('Grandchild');
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), 'Child');
		await body.press('ControlOrMeta+z');
		await expect(body.getByRole('checkbox', { name: 'Task: Child🙂', exact: true })).toBeChecked();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), source);
		await browser.page.evaluate(() => window.arkdownFixture.setListKind('task'));
		await expect(body.getByRole('checkbox', { name: 'Task: Child🙂', exact: true })).toBeChecked();
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('headings become lists without leaking heading delimiters into the text', async () => {
		for (const source of ['## 中文🙂 ##\n', '中文🙂\n====\n']) {
			await mount(source);
			const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
			await body.locator('h1, h2').click();
			await browser.page.evaluate(() => window.arkdownFixture.setListKind('task'));
			await expect(body.getByRole('checkbox', { name: 'Task: 中文🙂', exact: true })).toBeVisible();
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- [ ] 中文🙂\n');
			await body.press('ControlOrMeta+z');
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), source);
			assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
		}
	});

	test('checklist pointer and keyboard changes use Markdown history and retain text selection', async () => {
		await mount('- [ ] Ship docs\r\n- [x] Review docs\r\n');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		const task = body.getByRole('checkbox', { name: 'Task: Ship docs', exact: true });
		await expect(task).not.toBeChecked();
		await body.locator('.ash-arkdown-task-content p').first().evaluate(element => {
			element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 0, element.firstChild!, 4);
		});
		await task.click();
		await expect(task).toBeChecked();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- [x] Ship docs\r\n- [x] Review docs\r\n');
		assert.equal(await browser.page.evaluate(() => window.getSelection()?.toString()), 'Ship');
		await expect(body.locator('.ash-arkdown-task-item').first()).toHaveClass(/completed/);
		await body.press('ControlOrMeta+z');
		await expect(task).not.toBeChecked();
		await task.focus();
		await task.press('Space');
		await expect(task).toBeChecked();
		await expect(task).toBeFocused();
		await task.press('Space');
		await expect(task).not.toBeChecked();
		await expect(task).toBeFocused();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.plainText), '[ ] Ship docs\n\n[x] Review docs');
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		await expect(task).toBeDisabled();
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('nested checklists keep independent completion and survive offset changes and composition', async () => {
		await mount('Intro\n\n- [ ] Parent\n  - [ ] Child\n');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.locator('p').first().click();
		await body.press('Home');
		await browser.page.keyboard.insertText('前言🙂 ');
		const parent = body.getByRole('checkbox', { name: 'Task: Parent', exact: true });
		const child = body.getByRole('checkbox', { name: 'Task: Child', exact: true });
		await parent.click();
		await expect(parent).toBeChecked();
		await expect(child).not.toBeChecked();
		await child.click();
		await expect(child).toBeChecked();
		assert.ok((await browser.page.evaluate(() => window.arkdownFixture.source)).includes('- [x] Parent\n  - [x] Child'));
		await body.locator('.ash-arkdown-task-content p').last().click();
		await body.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
		await body.evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
		});
		await expect(body.getByRole('checkbox', { name: 'Task: Child中文', exact: true })).toBeChecked();
		await browser.page.evaluate(() => window.arkdownFixture.mode('markdown'));
		await browser.page.evaluate(() => window.arkdownFixture.mode('rich'));
		await expect(parent).toBeChecked();
		await expect(body.getByRole('checkbox', { name: 'Task: Child中文', exact: true })).toBeChecked();
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('an empty checklist has an editable caret and a native accessible checkbox', async () => {
		await mount('- [ ] \n');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await expect(body.getByRole('checkbox', { name: 'Empty task', exact: true })).not.toBeChecked();
		await body.locator('.ash-arkdown-task-content p').click();
		await browser.page.keyboard.insertText('New task');
		await expect(body.getByRole('checkbox', { name: 'Task: New task', exact: true })).toBeVisible();
		await body.press('ControlOrMeta+Enter');
		await expect(body.getByRole('checkbox', { name: 'Task: New task', exact: true })).toBeChecked();
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- [x] New task\n');
		await mount('- [ ] \n  - [ ] Nested\n');
		await body.locator('.ash-arkdown-task-content > p').first().click();
		await browser.page.keyboard.insertText('Parent');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '- [ ] Parent\n  - [ ] Nested\n');
		await expect(body.getByRole('checkbox', { name: 'Task: Nested', exact: true })).not.toBeChecked();
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
		await expect(body.locator('.ash-arkdown-task-content')).toHaveText('中文🙂');
		await expect(body.getByRole('checkbox', { name: 'Task: 中文🙂', exact: true })).not.toBeChecked();
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '中文🙂');
	});

	test('table Tab appends one editable row and Shift Tab moves backwards', async () => {
		const original = '| a | b |\n| - | - |\n| c | d |';
		await mount(original);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await expect(body.getByRole('columnheader')).toHaveText(['a', 'b']);
		await expect(body.getByRole('columnheader').first()).toHaveAttribute('scope', 'col');
		await body.getByRole('columnheader').first().click();
		await browser.page.keyboard.press('Tab');
		await browser.page.keyboard.insertText('头');
		await expect(body.getByRole('columnheader').last()).toContainText('头');
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
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

	test('Tab repeatedly creates rows through empty final cells', async () => {
		for (const eol of ['\n', '\r\n']) {
			await mount(['| 里程碑 | 目标日期 |', '| --- | --- |', '| 公开发布 | 下周一 |'].join(eol));
			const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
			await body.locator('td').last().click();
			for (let row = 2; row < 6; row++) {
				await browser.page.keyboard.press('Tab');
				await expect(body.locator('tr')).toHaveCount(row + 1);
				await browser.page.keyboard.press('Tab');
				assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
			}
		}
	});

	test('table navigation and typing reveal offscreen cells in the table scroll lane', async () => {
		const columns = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`);
		await mount(`| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.map(() => 'Long cell content'.repeat(5)).join(' | ')} |`);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		const scroll = body.locator('.ash-arkdown-table');
		await body.getByRole('columnheader').first().click();
		for (let index = 0; index < columns.length - 1; index++) await browser.page.keyboard.press('Tab');
		await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
		await browser.page.keyboard.insertText('末列');
		await expect(body.getByRole('columnheader').last()).toContainText('末列');
		await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
		const bounds = await scroll.boundingBox(), header = await body.getByRole('columnheader').last().boundingBox();
		assert.ok(bounds && header && header.x >= bounds.x - 1 && header.x + header.width <= bounds.x + bounds.width + 1);
		assert.ok(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
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

	for (const { name, prefix, suffix, selector } of [
		{ name: 'inline code', prefix: 'Before `', suffix: '` after', selector: 'code' },
		{ name: 'fenced code', prefix: '```js\n', suffix: '\n```\n', selector: 'pre' },
		{ name: 'indented code', prefix: '    ', suffix: '\n', selector: 'pre' },
	]) {
		test(`typing, pasting and composing in ${name} preserve literal code`, async () => {
			await mount(prefix + 'ab' + suffix);
			const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
			const code = body.locator(selector);
			await body.focus();
			await code.evaluate(element => element.ownerDocument.getSelection()!.collapse(element.firstChild!, 1));
			await browser.page.keyboard.insertText('_');
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), prefix + 'a_b' + suffix);
			const pasted = '[x]\\\\';
			await body.evaluate((element, text) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', text);
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, pasted);
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), prefix + `a_${pasted}b` + suffix);
			await body.evaluate(element => {
				const data = '中文*';
				element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
				element.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
				element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromComposition', data, bubbles: true, cancelable: true }));
			});
			const expected = `a_${pasted}中文*b`;
			assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), prefix + expected + suffix);
			await expect(code).toHaveText(expected);
			assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
		});
	}

	test('typing a backtick at the end of inline code preserves the code span and caret', async () => {
		await mount('Before `x` after');
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		const code = body.locator('code');
		await body.focus();
		await code.evaluate(element => element.ownerDocument.getSelection()!.collapse(element.firstChild!, 1));
		await browser.page.keyboard.insertText('`');
		await expect(code).toHaveText('x`');
		await browser.page.keyboard.insertText('_');
		await expect(code).toHaveText('x`_');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), 'Before `` x`_ `` after');
	});

	test('pasting a fence into code preserves the block and the following prose', async () => {
		const original = '```js\nalpha\n\nomega\n```\n\nAfter';
		await mount(original);
		const body = browser.page.getByRole('textbox', { name: 'Document body', exact: true });
		await body.focus();
		await body.locator('pre').evaluate(element => element.ownerDocument.getSelection()!.collapse(element.firstChild!, 'alpha\n'.length));
		await body.evaluate(element => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', '```');
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		});
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), '````js\nalpha\n```\nomega\n````\n\nAfter');
		await expect(body.locator('pre')).toHaveText('alpha\n```\nomega\n', { useInnerText: true });
		await expect(body.locator('p')).toHaveText('After');
		await body.press('ControlOrMeta+z');
		assert.equal(await browser.page.evaluate(() => window.arkdownFixture.source), original);
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
