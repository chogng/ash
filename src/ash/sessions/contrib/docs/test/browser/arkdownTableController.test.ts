import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Arkdown table interactions', () => {
	const browser = useBrowserTests();
	const original = '# Schedule\n\n| Task | Owner | Count |\n| --- | --- | --- |\n| Alpha | Ada | 3 |\n| Beta | Lin | 1 |\n| Gamma | Jun | 2 |\n\nAfter table';
	const body = () => browser.page.getByRole('textbox', { name: 'Document body', exact: true });
	const cell = (row: number, column: number) => body().locator(`table [data-row="${row}"][data-column="${column}"]`);
	const item = (name: string) => browser.page.getByRole('menuitem', { name, exact: true }).or(browser.page.getByRole('menuitemcheckbox', { name, exact: true }));
	const source = () => browser.page.evaluate(() => window.arkdownFixture.source);
	const mount = async (text = original) => {
		await browser.page.goto('/arkdown.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await browser.page.evaluate(text => window.arkdownFixture.mount(text), text);
	};
	const context = async (row: number, column: number) => { await cell(row, column).click({ button: 'right' }); await expect(item('Copy cells')).toBeVisible(); };
	const submenu = async (name: string) => { await item(name).focus(); await item(name).press('ArrowRight'); };
	const rectangle = async (top: number, left: number, bottom: number, right: number) => { await cell(top, left).click(); await cell(bottom, right).click({ modifiers: ['Shift'] }); };
	const undo = async () => { await body().press('ControlOrMeta+z'); };

	test('table handles stay on the grid edges and expand as narrow capsules without covering text', async () => {
		await mount();
		await browser.page.evaluate(() => document.body.classList.add('ash-sessions-window'));
		await cell(1, 0).hover();
		const row = browser.page.getByRole('button', { name: 'Row 2 options', exact: true });
		const column = browser.page.getByRole('button', { name: 'Column 1 options', exact: true });
		const table = await body().getByRole('table').boundingBox(), first = await cell(1, 0).boundingBox();
		assert.ok(table && first);
		const rowBounds = await row.boundingBox(), columnBounds = await column.boundingBox();
		assert.ok(rowBounds && columnBounds);
		assert.deepEqual([rowBounds.width, rowBounds.height], [14, 24]);
		assert.deepEqual([columnBounds.width, columnBounds.height], [24, 14]);
		assert.ok(Math.abs(rowBounds.x + rowBounds.width / 2 - table.x) <= 1);
		assert.ok(Math.abs(columnBounds.y + columnBounds.height / 2 - table.y) <= 1);
		const resting = await row.evaluate(element => { const style = getComputedStyle(element, '::before'); return [style.width, style.height]; });
		assert.deepEqual(resting, ['8px', '24px']);
		await row.hover();
		const expanded = await row.evaluate(element => { const style = getComputedStyle(element, '::before'); return [style.width, style.height]; });
		assert.deepEqual(expanded, ['14px', '24px']);
		const textStart = await cell(1, 0).evaluate(element => { const range = element.ownerDocument.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect().left; });
		assert.ok(rowBounds.x + rowBounds.width < textStart, 'the row handle must leave its cell text uncovered');
		const drag = await browser.page.getByRole('button', { name: 'Select table', exact: true }).boundingBox();
		assert.ok(drag && drag.x >= (await body().boundingBox())!.x && drag.x + drag.width < table.x - 7);
		await expect(browser.page.getByRole('button', { name: 'Table options', exact: true })).toBeVisible();
		await cell(3, 2).hover();
		for (const name of ['Add row', 'Add column']) {
			const add = browser.page.getByRole('button', { name, exact: true });
			const icon = add.locator('.ash-icon');
			await expect(icon).toHaveCSS('font-size', '12px');
			await expect(icon).toHaveCSS('width', '12px');
			await expect(icon).toHaveCSS('height', '12px');
		}
	});

	test('clicking table borders and padding places a text caret inside the nearest cell', async () => {
		await mount();
		const table = await body().getByRole('table').boundingBox();
		assert.ok(table);
		for (const point of [{ x: table.x + 2, y: table.y - 4 }, { x: table.x + 1, y: table.y + 1 }]) {
			await browser.page.mouse.click(point.x, point.y);
			const caret = await browser.page.evaluate(() => {
				const selection = getSelection()!;
				const parent = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode as Element : selection.focusNode?.parentElement;
				const cell = parent?.closest('td, th');
				const caret = selection.getRangeAt(0).getBoundingClientRect();
				const text = document.createRange();
				if (cell) text.selectNodeContents(cell);
				const bounds = text.getBoundingClientRect();
				return { tag: parent?.tagName, cell: cell?.textContent, collapsed: selection.isCollapsed, caret: { x: caret.x, y: caret.y, height: caret.height }, text: { x: bounds.x, y: bounds.y, height: bounds.height } };
			});
			assert.equal(caret.cell, 'Task', JSON.stringify(caret));
			assert.equal(caret.collapsed, true);
			assert.ok(caret.caret.height > 0);
			assert.ok(Math.abs(caret.caret.height - caret.text.height) < 1, 'the native caret follows the cell text size');
			assert.ok(Math.abs(caret.caret.y - caret.text.y) < 1, 'the caret aligns vertically with the cell text');
			assert.ok(Math.abs(caret.caret.x - caret.text.x) < 1, 'the caret starts at the text inset, not the table border');
		}
		await browser.page.keyboard.insertText('New ');
		await expect(cell(0, 0)).toHaveText('New Task');
		await undo();
		assert.equal(await source(), original);
	});

	test('native navigation skips the table scroll container and keeps the caret on text', async () => {
		await mount('## Schedule\n\n| Task | Owner |\n| --- | --- |\n| Alpha | Ada |\n\nAfter table');
		const table = (await body().getByRole('table').boundingBox())!;
		await browser.page.mouse.click(table.x - 1, table.y + 1);
		await expect.poll(() => browser.page.evaluate(() => getSelection()?.focusNode?.parentElement?.closest('th')?.textContent)).toBe('Task');
		const heading = body().locator('h2');
		await heading.evaluate(element => element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 8, element.firstChild!, 8));
		await browser.page.keyboard.press('ArrowRight');
		await expect.poll(() => browser.page.evaluate(() => {
			const node = getSelection()?.focusNode;
			return node?.parentElement?.closest('th')?.textContent;
		})).toBe('Task');
		const caret = await cell(0, 0).evaluate(element => {
			const selection = element.ownerDocument.getSelection()!;
			const text = element.ownerDocument.createRange(); text.selectNodeContents(element);
			return { caret: selection.getRangeAt(0).getBoundingClientRect().toJSON(), text: text.getBoundingClientRect().toJSON() };
		});
		assert.ok(caret.caret.height > 0);
		assert.ok(Math.abs(caret.caret.height - caret.text.height) < 1);
		assert.ok(Math.abs(caret.caret.x - caret.text.x) < 1);
		assert.ok(Math.abs(caret.caret.y - caret.text.y) < 1);
		await browser.page.keyboard.press('ArrowLeft');
		await expect.poll(() => heading.evaluate(element => element.contains(element.ownerDocument.getSelection()?.focusNode ?? null))).toBe(true);
		await browser.page.keyboard.insertText('!');
		await expect(heading).toHaveText('Schedule!');
		await expect(cell(0, 0)).toHaveText('Task');
		await undo();
		await cell(1, 1).evaluate(element => element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 3, element.firstChild!, 3));
		await browser.page.keyboard.press('ArrowRight');
		await expect.poll(() => body().getByText('After table', { exact: true }).evaluate(element => element.contains(element.ownerDocument.getSelection()?.focusNode ?? null))).toBe(true);
		await browser.page.keyboard.press('ArrowLeft');
		await expect.poll(() => browser.page.evaluate(() => getSelection()?.focusNode?.parentElement?.closest('td')?.textContent)).toBe('Ada');
	});

	test('cells create headings, lists and checked tasks through the shared source and undo history', async () => {
		for (const content of ['中文 **内容**🙂', '']) {
			const initial = `| A | B |\r\n| --- | --- |\r\n| ${content} | Neighbor |`;
			await mount(initial);
			await cell(1, 0).click();
			await body().press('ControlOrMeta+Alt+Digit2');
			await expect(cell(1, 0).locator('h2')).toHaveText(content ? '中文 内容🙂' : '');
			await body().press('ControlOrMeta+Shift+Digit9');
			const checkbox = cell(1, 0).getByRole('checkbox');
			await expect(checkbox).not.toBeChecked();
			if (!content) await browser.page.keyboard.insertText('New task');
			await checkbox.click();
			await expect(checkbox).toBeChecked();
			const saved = await source();
			await mount(saved);
			await expect(cell(1, 0).getByRole('checkbox')).toBeChecked();
			await expect(cell(1, 1)).toHaveText('Neighbor');
			await cell(1, 0).locator('.ash-arkdown-task-content p').click();
			await browser.page.evaluate(() => window.arkdownFixture.setListKind('ordered'));
			await expect(cell(1, 0).locator('ol > li')).toHaveText(content ? '中文 内容🙂' : 'New task');
			await undo();
			await expect(cell(1, 0).getByRole('checkbox')).toBeChecked();
			assert.equal(await source(), saved);
			assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
		}
	});

	test('cell rectangles and virtual cells create block structures without altering neighboring cells', async () => {
		await mount('| A | B | C |\n| - | - | - |\n| Short |\n| One | Two | Three |');
		await cell(1, 2).click();
		await browser.page.evaluate(() => window.arkdownFixture.setListKind('task'));
		await expect(cell(1, 2).getByRole('checkbox')).toHaveCount(1);
		await browser.page.keyboard.insertText('Created');
		await expect(cell(1, 2)).toContainText('Created');
		await rectangle(2, 0, 2, 1);
		await browser.page.evaluate(() => window.arkdownFixture.setHeading(3));
		await expect(cell(2, 0).locator('h3')).toHaveText('One');
		await expect(cell(2, 1).locator('h3')).toHaveText('Two');
		await expect(cell(2, 2)).toHaveText('Three');
		await browser.page.evaluate(() => window.arkdownFixture.format('**'));
		await expect(cell(2, 0).locator('h3 strong')).toHaveText('One');
		await expect(cell(2, 1).locator('h3 strong')).toHaveText('Two');
		await undo();
		await expect(cell(2, 0).locator('h3')).toHaveText('One');
		await undo();
		await expect(cell(2, 0).locator('h3')).toHaveCount(0);
		await expect(cell(2, 1).locator('h3')).toHaveCount(0);
		await expect(cell(1, 2).getByRole('checkbox')).toHaveCount(1);
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		const saved = await source();
		await browser.page.evaluate(() => window.arkdownFixture.setListKind('task'));
		assert.equal(await source(), saved);
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('Enter creates cell list items, preserves inline marks and exits an empty item to a paragraph', async () => {
		await mount('| A | B |\n| - | - |\n| First | Neighbor |');
		await cell(1, 0).click();
		await browser.page.evaluate(() => window.arkdownFixture.setListKind('task'));
		await cell(1, 0).locator('.ash-arkdown-task-content p').evaluate(element => {
			element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, 5, element.firstChild!, 5);
		});
		await browser.page.keyboard.press('Enter');
		await browser.page.keyboard.insertText('Second');
		await expect(cell(1, 0).getByRole('checkbox')).toHaveCount(2);
		await expect(cell(1, 0).locator('.ash-arkdown-task-content p')).toHaveText(['First', 'Second']);
		await browser.page.keyboard.press('Enter');
		await expect(cell(1, 0).getByRole('checkbox')).toHaveCount(3);
		await browser.page.keyboard.press('Enter');
		await expect(cell(1, 0).getByRole('checkbox')).toHaveCount(2);
		await browser.page.keyboard.insertText('Paragraph');
		await expect(cell(1, 0).locator(':scope > p')).toHaveText('Paragraph');
		await body().press('ControlOrMeta+Alt+Digit3');
		await expect(cell(1, 0).locator('h3')).toHaveText('Paragraph');
		await expect(cell(1, 0).getByRole('checkbox')).toHaveCount(2);
		await browser.page.keyboard.press('Enter');
		await browser.page.keyboard.insertText('After heading');
		await expect(cell(1, 0).locator(':scope > p')).toHaveText('After heading');
		await expect(cell(1, 1)).toHaveText('Neighbor');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
		const saved = await source();
		await mount(saved);
		await expect(cell(1, 0).getByRole('checkbox')).toHaveCount(2);
		await expect(cell(1, 0).locator('h3')).toHaveText('Paragraph');
		await expect(cell(1, 0).locator(':scope > p')).toHaveText('After heading');
		for (const offset of [0, 2, 4]) {
			await mount('| A |\n| - |\n| <ul><li>**bold**</li></ul> |');
			await cell(1, 0).locator('strong').evaluate((element, offset) => {
				element.ownerDocument.getSelection()!.setBaseAndExtent(element.firstChild!, offset, element.firstChild!, offset);
			}, offset);
			await browser.page.keyboard.press('Enter');
			await expect(cell(1, 0).locator('li')).toHaveText(['bold'.slice(0, offset), 'bold'.slice(offset)]);
			await expect(cell(1, 0).locator('li strong')).toHaveCount(offset === 2 ? 2 : 1);
			await undo();
			await expect(cell(1, 0).locator('li strong')).toHaveText('bold');
		}
	});

	test('new rows retain normal cell height and new columns accept input at the revealed caret', async () => {
		await mount(); await cell(3, 2).hover();
		const previous = await cell(3, 2).boundingBox(); assert.ok(previous);
		await browser.page.getByRole('button', { name: 'Add row', exact: true }).click();
		const empty = await cell(4, 2).boundingBox(); assert.ok(empty);
		assert.ok(empty.height >= previous.height - 1, `new row height ${empty.height} must retain the ${previous.height} text line`);
		await browser.page.keyboard.insertText('Added row'); await expect(cell(4, 2)).toHaveText('Added row');
		await undo(); await expect(cell(4, 2)).toHaveText(''); await undo(); assert.equal(await source(), original);
		await cell(3, 2).hover(); await browser.page.getByRole('button', { name: 'Add column', exact: true }).click();
		await expect(body().getByRole('columnheader')).toHaveCount(4);
		const added = await cell(3, 3).boundingBox(); assert.ok(added && added.width >= 48);
		await browser.page.keyboard.insertText('Added column'); await expect(cell(3, 3)).toHaveText('Added column');
		await undo(); await undo(); assert.equal(await source(), original);
		for (let row = 4; row < 6; row++) {
			await cell(row - 1, 2).hover();
			await browser.page.getByRole('button', { name: 'Add row', exact: true }).click();
			const addedRow = await cell(row, 2).boundingBox(); assert.ok(addedRow && addedRow.height >= previous.height - 1);
		}
		for (let column = 3; column < 5; column++) {
			await cell(5, column - 1).hover();
			await browser.page.getByRole('button', { name: 'Add column', exact: true }).click();
		}
		await browser.page.keyboard.insertText('Last new cell'); await expect(cell(5, 4)).toHaveText('Last new cell');
		for (let edit = 0; edit < 5; edit++) await undo();
		assert.equal(await source(), original);
	});

	test('whole-table selection keeps the grid, uses a soft fill and formats real cells through one undo entry', async () => {
		await mount();
		await context(1, 0); await submenu('Set column width'); await item('Medium').click();
		const saved = await source();
		await cell(1, 0).hover();
		const before = await cell(1, 0).evaluate(element => { const style = getComputedStyle(element); return [style.borderColor, style.color]; });
		await browser.page.getByRole('button', { name: 'Select table', exact: true }).click();
		await expect(body().locator('.ash-arkdown-cell-selected')).toHaveCount(12);
		const appearance = await cell(1, 0).evaluate(element => { const style = getComputedStyle(element), fill = getComputedStyle(element, '::after'); return { border: style.borderColor, color: style.color, outline: style.outlineStyle, fill: fill.backgroundColor }; });
		assert.deepEqual([appearance.border, appearance.color], before);
		assert.equal(appearance.outline, 'none');
		assert.match(appearance.fill, /\/ 0\.1\)/u);
		assert.ok(await browser.page.evaluate(() => window.arkdownFixture.selectionBounds?.width > 0));
		await browser.page.evaluate(() => window.arkdownFixture.format('**'));
		await expect(cell(0, 0).locator('strong')).toHaveText('Task'); await expect(cell(1, 0).locator('strong')).toHaveText('Alpha');
		await expect(body().locator('.ash-arkdown-cell-selected')).toHaveCount(12);
		await expect(body().locator('col').first()).toHaveCSS('width', '224px');
		assert.ok((await source()).endsWith(saved.slice(saved.indexOf('<!-- ash-table '))));
		await browser.page.evaluate(() => window.arkdownFixture.format('**'));
		await expect(body().locator('strong')).toHaveCount(0);
		await undo(); await expect(cell(1, 0).locator('strong')).toHaveText('Alpha');
		await undo(); assert.equal(await source(), saved);
		await rectangle(1, 0, 2, 1); await browser.page.evaluate(() => window.arkdownFixture.toggleUnderline());
		await expect(cell(1, 0).locator('u')).toHaveText('Alpha'); await expect(cell(2, 1).locator('u')).toHaveText('Lin');
		await expect(cell(3, 0).locator('u')).toHaveCount(0);
		await undo(); assert.equal(await source(), saved);
	});

	test('cell menus insert and delete rows and columns through one shared undo transaction', async () => {
		await mount();
		await context(1, 1);
		await item('Insert row above').click();
		await expect(body().getByRole('row')).toHaveCount(5);
		await expect(cell(1, 0)).toHaveText('');
		await undo();
		assert.equal(await source(), original);
		await context(1, 1);
		await item('Insert column right').click();
		await expect(body().getByRole('columnheader')).toHaveCount(4);
		await expect(cell(1, 2)).toHaveText('');
		await undo();
		assert.equal(await source(), original);
		await context(2, 1);
		await item('Delete row').click();
		await expect(body().getByRole('row')).toHaveCount(3);
		await expect(body()).not.toContainText('Beta');
		await undo();
		assert.equal(await source(), original);
		await cell(1, 0).click();
		await body().press('Shift+F10');
		await expect(item('Delete table')).toBeVisible();
		await browser.page.keyboard.press('Escape');
		assert.ok(await body().evaluate(element => element.contains(element.ownerDocument.activeElement)));
	});

	test('width, alignment, fill and header state survive a new editor and support undo', async () => {
		await mount();
		await context(1, 0); await submenu('Set column width'); await item('Medium').click();
		await expect(body().locator('col').first()).toHaveCSS('width', '224px');
		await context(1, 0); await item('Align right').click();
		await expect(cell(1, 0)).toHaveCSS('text-align', 'right');
		await context(1, 0); await submenu('Cell color'); await item('Red').click();
		await browser.page.keyboard.press('Escape');
		await expect(cell(1, 0)).toHaveClass(/ash-arkdown-cell-red/u);
		await context(1, 0); await item('Header row').click();
		await expect(body().getByRole('columnheader')).toHaveCount(0);
		const saved = await source();
		assert.ok(saved.includes('<!-- ash-table '));
		assert.ok(!await browser.page.evaluate(() => window.arkdownFixture.plainText.includes('ash-table')));
		await mount(saved);
		await expect(body().locator('col').first()).toHaveCSS('width', '224px');
		await expect(cell(1, 0)).toHaveClass(/ash-arkdown-cell-red/u);
		await expect(body().getByRole('columnheader')).toHaveCount(0);
		await context(1, 0); await item('Header row').click();
		await expect(body().getByRole('columnheader')).toHaveCount(3);
		await undo();
		assert.equal(await source(), saved);
	});

	test('rectangular merge and split preserve all text and source-backed layout', async () => {
		await mount();
		await rectangle(1, 0, 2, 1);
		await expect(body().locator('.ash-arkdown-cell-selected:not([hidden])')).toHaveCount(4);
		await context(1, 0); await item('Merge cells').click();
		await expect(cell(1, 0)).toHaveAttribute('rowspan', '2');
		await expect(cell(1, 0)).toHaveAttribute('colspan', '2');
		await expect(cell(1, 0)).toHaveText('Alpha Ada Beta Lin');
		await expect(cell(2, 1)).toBeHidden();
		const saved = await source();
		await mount(saved);
		await expect(cell(1, 0)).toHaveAttribute('rowspan', '2');
		await context(1, 0); await expect(item('Sort column ascending')).toBeDisabled(); await item('Split cell').click();
		await expect(cell(2, 1)).toBeVisible();
		await expect(cell(1, 0)).toHaveText('Alpha Ada Beta Lin');
		await undo();
		assert.equal(await source(), saved);
	});

	test('rectangle typing, IME cancellation and composition commit use atomic history', async () => {
		await mount();
		await rectangle(1, 0, 2, 1);
		await browser.page.keyboard.insertText('替换🙂');
		await expect(cell(1, 0)).toHaveText('替换🙂');
		await expect(cell(1, 1)).toHaveText('');
		await expect(cell(2, 0)).toHaveText('');
		await undo(); assert.equal(await source(), original);
		await rectangle(1, 0, 2, 1);
		await body().evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
		});
		assert.equal(await source(), original);
		await rectangle(1, 0, 2, 1);
		await body().evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
			element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromComposition', data: '中文', bubbles: true, cancelable: true }));
		});
		await expect(cell(1, 0)).toHaveText('中文');
		await expect(cell(2, 1)).toHaveText('');
		await undo(); assert.equal(await source(), original);
	});

	test('rectangular clipboard data stays inert and can fill, copy and clear a selection', async () => {
		await mount(); await rectangle(1, 0, 2, 1);
		await body().evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', 'A\tB\nC\t<script>'); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
		await expect(cell(1, 0)).toHaveText('A'); await expect(cell(2, 1)).toHaveText('<script>');
		await expect(body().locator('script')).toHaveCount(0);
		await rectangle(1, 0, 2, 1);
		const copied = await body().evaluate(element => { const data = new DataTransfer(); element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })); return { text: data.getData('text/plain'), html: data.getData('text/html') }; });
		assert.equal(copied.text, 'A\tB\nC\t<script>'); assert.ok(copied.html.includes('&lt;script&gt;'));
		await body().press('Backspace'); await expect(cell(1, 0)).toHaveText(''); await expect(cell(2, 1)).toHaveText('');
		await undo(); await expect(cell(2, 1)).toHaveText('<script>');
	});

	test('sorting, row movement and whole-row deletion preserve the header', async () => {
		await mount(); await context(1, 2); await item('Sort column ascending').click();
		await expect(body().locator('[data-column="0"]')).toHaveText(['Task', 'Beta', 'Gamma', 'Alpha']);
		await context(2, 0); await submenu('Move row or column'); await item('Move row up').click();
		await expect(body().locator('[data-column="0"]')).toHaveText(['Task', 'Gamma', 'Beta', 'Alpha']);
		await cell(1, 0).hover(); await browser.page.getByRole('button', { name: 'Row 2 options', exact: true }).click();
		await expect(item('Insert row above')).toBeVisible();
		await expect(item('Insert column left')).toHaveCount(0);
		await browser.page.keyboard.down('Delete');
		const deleted = await source();
		await browser.page.keyboard.down('Delete');
		assert.equal(await source(), deleted);
		await browser.page.keyboard.up('Delete');
		await expect(body().getByRole('row')).toHaveCount(3); await expect(body()).not.toContainText('Gamma');
		await undo(); await expect(body().getByRole('row')).toHaveCount(4);
	});

	test('read-only cell menus allow copying and disable every source mutation', async () => {
		await mount(); await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		await context(1, 0);
		await expect(item('Copy cells')).toBeEnabled(); await expect(item('Insert row above')).toBeDisabled(); await expect(item('Delete table')).toBeDisabled();
		await browser.page.keyboard.press('Escape'); await rectangle(1, 0, 2, 1); await body().press('Delete');
		await body().evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', 'blocked\tvalue'); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
		assert.equal(await source(), original);
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('triple-click selects a cell and complete row or column rectangles delete their grid axis', async () => {
		await mount(); await cell(1, 1).click({ clickCount: 3 });
		await expect(body().locator('.ash-arkdown-cell-selected')).toHaveCount(1);
		await browser.page.keyboard.insertText('New owner'); await expect(cell(1, 1)).toHaveText('New owner');
		await undo(); assert.equal(await source(), original);
		await rectangle(1, 0, 1, 2); await body().press('Delete');
		await expect(body().getByRole('row')).toHaveCount(3); await expect(body()).not.toContainText('Alpha');
		await undo(); assert.equal(await source(), original);
		await rectangle(0, 1, 3, 1); await body().press('Delete');
		await expect(body().getByRole('columnheader')).toHaveText(['Task', 'Count']);
		await undo(); assert.equal(await source(), original);
		await cell(1, 1).hover(); await browser.page.getByRole('button', { name: 'Column 2 options', exact: true }).click();
		await expect(item('Insert column left')).toBeVisible(); await expect(item('Insert row above')).toHaveCount(0);
		await browser.page.keyboard.press('Delete'); await expect(body().getByRole('columnheader')).toHaveText(['Task', 'Count']);
		await undo(); assert.equal(await source(), original);
	});

	test('row handles drag to reorder and column separators resize through one undo entry', async () => {
		await mount(); await cell(1, 0).hover();
		const grip = await browser.page.getByRole('button', { name: 'Row 2 options', exact: true }).boundingBox();
		const last = await cell(3, 0).boundingBox();
		assert.ok(grip && last);
		await browser.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await browser.page.mouse.down();
		await browser.page.mouse.move(grip.x + grip.width / 2, last.y + last.height + 2, { steps: 12 }); await browser.page.mouse.up();
		await expect(body().locator('[data-column="0"]')).toHaveText(['Task', 'Beta', 'Gamma', 'Alpha']);
		await undo(); assert.equal(await source(), original);
		await cell(1, 0).hover();
		const separator = browser.page.getByRole('separator', { name: 'Resize column 1', exact: true });
		const width = Number(await separator.getAttribute('aria-valuenow'));
		await separator.press('ArrowRight');
		await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(width + 8);
		await undo(); assert.equal(await source(), original);
		await cell(1, 0).hover();
		const edge = await separator.boundingBox(); assert.ok(edge);
		await browser.page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await browser.page.mouse.down();
		await browser.page.mouse.move(edge.x + edge.width / 2 + 64, edge.y + edge.height / 2, { steps: 12 }); await browser.page.mouse.up();
		await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(width + 60);
		await undo(); assert.equal(await source(), original);
	});

	test('whole-table handles move the source block with layout, cancellation, keyboard access and shared undo', async () => {
		await mount(original.replace(/\n/gu, '\r\n'));
		await context(1, 0); await submenu('Set column width'); await item('Medium').click();
		const saved = await source(), handle = browser.page.getByRole('button', { name: 'Select table', exact: true });
		await cell(1, 0).hover(); const grip = await handle.boundingBox(), paragraph = await body().getByText('After table', { exact: true }).boundingBox(); assert.ok(grip && paragraph);
		const drag = async () => { await browser.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await browser.page.mouse.down(); await browser.page.mouse.move(grip.x + grip.width / 2, paragraph.y + paragraph.height + 10, { steps: 12 }); };
		await drag(); await browser.page.keyboard.press('Escape'); await browser.page.mouse.up();
		assert.equal(await source(), saved);
		await drag(); await browser.page.mouse.up();
		assert.ok((await source()).indexOf('After table') < (await source()).indexOf('| Task |'));
		await expect(body().locator('col').first()).toHaveCSS('width', '224px');
		await expect(body().getByRole('row')).toHaveCount(4);
		await undo(); assert.equal(await source(), saved);
		await cell(1, 0).hover(); await handle.focus(); await handle.press('Alt+ArrowUp');
		assert.ok((await source()).indexOf('| Task |') < (await source()).indexOf('# Schedule'));
		await handle.press('Alt+ArrowDown');
		assert.ok((await source()).indexOf('# Schedule') < (await source()).indexOf('| Task |'));
		await undo(); await undo(); assert.equal(await source(), saved);
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true));
		await expect(handle).toBeHidden(); assert.equal(await source(), saved);
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('HTML clipboard round trips merged cells and closed fill colors without executing markup', async () => {
		await mount(); await rectangle(1, 0, 2, 1); await context(1, 0); await item('Merge cells').click();
		await context(1, 0); await submenu('Cell color'); await item('Red').click();
		await context(1, 0); await browser.page.keyboard.press('Escape');
		const html = await body().evaluate(element => { const data = new DataTransfer(); element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })); return data.getData('text/html'); });
		assert.ok(html.includes('rowspan="2"') && html.includes('data-ash-table-color="red"'));
		await mount(); await cell(1, 0).click();
		await body().evaluate((element, html) => { const data = new DataTransfer(); data.setData('text/html', html); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, html);
		await expect(cell(1, 0)).toHaveAttribute('rowspan', '2'); await expect(cell(1, 0)).toHaveAttribute('colspan', '2');
		await expect(cell(1, 0)).toHaveClass(/ash-arkdown-cell-red/u); await expect(cell(1, 0)).toHaveText('Alpha Ada Beta Lin');
		await undo(); assert.equal(await source(), original);
	});

	test('virtual cells, literal pipes and newlines remain editable without breaking GFM structure', async () => {
		const short = '| A | B | C |\r\n| --- | --- | --- |\r\n| one |\r\n| next | row | safe |';
		await mount(short); await cell(1, 0).click(); await browser.page.keyboard.press('Tab'); await browser.page.keyboard.press('Tab');
		await browser.page.keyboard.insertText('missing🙂');
		await expect(cell(1, 2)).toHaveText('missing🙂'); await expect(cell(2, 0)).toHaveText('next');
		await undo(); assert.equal(await source(), short);
		await cell(2, 1).click(); await body().press('ArrowRight'); await browser.page.keyboard.insertText('| &amp;');
		await expect(cell(2, 1)).toContainText('| &amp;'); await expect(body().getByRole('columnheader')).toHaveCount(3);
		await body().press('Enter'); await browser.page.keyboard.insertText('newline');
		await expect(cell(2, 1)).toContainText('\nnewline'); await expect(body().getByRole('row')).toHaveCount(3);
		await expect(body()).not.toContainText('ash-table');
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});
});
