import assert from 'node:assert/strict';
import { setup, suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { HistoryInputBox, InputBox } from '../../browser/ui/inputbox/inputbox.js';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('InputBox focus selection in the browser', () => {
	const browser = useBrowserTests();
	setup(async () => {
		await browser.page.goto('/inputbox.html');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
	});

	test('default and explicitly disabled selection preserve click positioning', async () => {
		for (const name of ['Default', 'Disabled selection']) {
			const input = browser.page.getByRole('textbox', { name, exact: true });
			await input.click({ position: { x: 9, y: 12 } });
			assert.deepEqual(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]), [0, 0]);
		}
	});

	test('first click selects the value while subsequent clicks and drags place the caret normally', async () => {
		const { page } = browser;
		const input = page.getByRole('textbox', { name: 'Select text', exact: true });
		await input.click({ position: { x: 9, y: 12 } });
		assert.deepEqual(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]), [0, 6]);
		await input.click({ position: { x: 9, y: 12 } });
		assert.deepEqual(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]), [0, 0]);
		const bounds = (await input.boundingBox())!;
		await page.mouse.move(bounds.x + 9, bounds.y + 12);
		await page.mouse.down();
		await page.mouse.move(bounds.x + 30, bounds.y + 12, { steps: 5 });
		await page.mouse.up();
		const selection = await input.evaluate((element: HTMLInputElement) => [element.selectionStart!, element.selectionEnd!]);
		assert.equal(selection[0], 0);
		assert.ok(selection[1]! > 0 && selection[1]! < 6);
		await page.getByRole('button', { name: 'Before inputs' }).click();
		await input.click();
		await page.keyboard.insertText('ABCDEF');
		await expect(input).toHaveValue('ABCDEF');
	});

	test('flexible input keeps scrollbar controls fixed while its textarea scrolls', async () => {
		const { page } = browser;
		const input = page.getByRole('textbox', { name: 'Select multiline', exact: true });
		const value = Array.from({ length: 40 }, (_, index) => `input line ${index}`).join('\n');
		await input.fill(value);
		await input.evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 0; });
		await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.scrollHeight > element.clientHeight)).toBe(true);
		const host = input.locator('..');
		const track = host.getByRole('scrollbar', { name: 'Vertical scrollbar' });
		const trackOffset = (): Promise<number> => track.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top);
		const initialOffset = await trackOffset();
		await input.hover();
		await page.mouse.wheel(0, 200);
		await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBeGreaterThan(0);
		await expect.poll(trackOffset).toBe(initialOffset);
		await expect.poll(async () => Number(await track.getAttribute('aria-valuenow')) - Math.round(await input.evaluate((element: HTMLTextAreaElement) => element.scrollTop))).toBe(0);
		expect(await host.evaluate(element => element.scrollTop)).toBe(0);
		await track.focus();
		await track.press('Home');
		await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBe(0);
		await expect(input).toHaveValue(value);
	});

	test('Tab entry selects text and numeric values and programmatic focus selects multiline values', async () => {
		const { page } = browser;
		await page.getByRole('textbox', { name: 'Disabled selection', exact: true }).focus();
		await page.keyboard.press('Tab');
		const text = page.getByRole('textbox', { name: 'Select text', exact: true });
		await expect(text).toBeFocused();
		await page.keyboard.insertText('123456');
		await expect(text).toHaveValue('123456');
		await page.keyboard.press('Tab');
		const numeric = page.getByRole('spinbutton', { name: 'Select number', exact: true });
		await expect(numeric).toBeFocused();
		await page.keyboard.insertText('42');
		await expect(numeric).toHaveValue('42');
		await page.getByRole('button', { name: 'Before inputs' }).click();
		await numeric.click();
		await page.keyboard.insertText('16');
		await expect(numeric).toHaveValue('16');
		const multiline = page.getByRole('textbox', { name: 'Select multiline', exact: true });
		await multiline.focus();
		await page.keyboard.insertText('new\nvalue');
		await expect(multiline).toHaveValue('new\nvalue');
	});
});

test('Flexible InputBox preserves multiline editing, selection and validation without changing default numeric inputs', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using input = new InputBox(dom.window.document.body, { flexibleHeight: true, flexibleMaxHeight: 134, presentation: 'compact' });
	using numeric = new InputBox(dom.window.document.body, { type: 'number' });
	const changed: string[] = [];
	input.onDidChange(value => changed.push(value));
	input.value = '中文😀\nsecond';
	input.focus();
	input.select({ start: 2, end: 4 });
	input.showValidation('Invalid pattern');
	assert.deepEqual({ tag: input.inputElement.tagName, value: input.value, selection: [input.inputElement.selectionStart, input.inputElement.selectionEnd], changed, invalid: input.inputElement.getAttribute('aria-invalid') }, {
		tag: 'TEXTAREA', value: '中文😀\nsecond', selection: [2, 4], changed: ['中文😀\nsecond'], invalid: 'true',
	});
	numeric.inputElement.valueAsNumber = 3;
	numeric.step = '2';
	assert.deepEqual([numeric.inputElement.tagName, numeric.inputElement.type, numeric.inputElement.valueAsNumber, numeric.step], ['INPUT', 'number', 3, '2']);
	input.dispose(); numeric.dispose();
	dom.window.close();
});

test('Flexible history input retains multiline entries and restores the multiline draft', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using input = new HistoryInputBox(dom.window.document.body, { flexibleHeight: true, history: new Set(['saved\nquery']) });
	input.value = 'current\ndraft';
	input.showPreviousValue();
	assert.equal(input.value, 'saved\nquery');
	input.showNextValue();
	assert.equal(input.value, 'current\ndraft');
	input.addToHistory();
	assert.deepEqual(input.getHistory(), ['saved\nquery', 'current\ndraft']);
	input.dispose();
	dom.window.close();
});

test('InputBox exposes value, keyboard, focus, and selection behavior', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const inputBox = new InputBox(dom.window.document.body, {
		placeholder: 'Search',
		ariaLabel: 'Search commands',
	});
	dom.window.document.body.append(inputBox.element);
	const values: string[] = [];
	const keys: string[] = [];
	let focusCount = 0;
	let blurCount = 0;
	inputBox.onDidChange((value) => values.push(value));
	inputBox.onKeyDown((event) => keys.push(event.key));
	inputBox.onDidFocus(() => focusCount += 1);
	inputBox.onDidBlur(() => blurCount += 1);

	inputBox.value = 'command';
	inputBox.value = 'command';
	assert.deepEqual(values, ['command']);
	assert.equal(inputBox.placeholder, 'Search');
	assert.equal(
		inputBox.inputElement.getAttribute('aria-label'),
		'Search commands',
	);

	inputBox.focus();
	assert.equal(inputBox.hasFocus(), true);
	inputBox.select({ start: 1, end: 4 });
	assert.equal(inputBox.inputElement.selectionStart, 1);
	assert.equal(inputBox.inputElement.selectionEnd, 4);
	inputBox.inputElement.dispatchEvent(new dom.window.KeyboardEvent(
		'keydown',
		{ bubbles: true, key: 'ArrowDown' },
	));
	inputBox.blur();
	assert.deepEqual(keys, ['ArrowDown']);
	assert.equal(focusCount, 1);
	assert.equal(blurCount, 1);

	inputBox.dispose();
	dom.window.close();
});

test('InputBox owns enabled, read-only, and validation accessibility state', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const inputBox = new InputBox(dom.window.document.body, {
		enabled: false,
		readOnly: true,
	});

	assert.equal(inputBox.enabled, false);
	assert.equal(inputBox.element.classList.contains('is-disabled'), true);
	assert.equal(inputBox.inputElement.readOnly, true);
	inputBox.enabled = true;
	inputBox.readOnly = false;
	assert.equal(inputBox.enabled, true);
	assert.equal(inputBox.inputElement.readOnly, false);

	inputBox.showValidation('A value is required');
	assert.equal(inputBox.inputElement.getAttribute('aria-invalid'), 'true');
	assert.ok(inputBox.inputElement.getAttribute('aria-describedby'));
	const message = dom.window.document.getElementById(inputBox.inputElement.getAttribute('aria-describedby')!)!;
	assert.equal(message.hidden, false);
	inputBox.showValidation('A valid number is required', 'accessible');
	assert.equal(message.hidden, true);
	assert.equal(message.textContent, 'A valid number is required');
	assert.equal(inputBox.inputElement.getAttribute('aria-describedby'), message.id);
	assert.equal(inputBox.inputElement.getAttribute('aria-invalid'), 'true');
	inputBox.showValidation('A value is required');
	assert.equal(message.hidden, false);
	inputBox.showValidation('');
	assert.equal(inputBox.inputElement.hasAttribute('aria-invalid'), false);
	assert.equal(
		inputBox.inputElement.hasAttribute('aria-describedby'),
		false,
	);

	inputBox.dispose();
	dom.window.close();
});

test('InputBox supports numeric field presentation', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const inputBox = new InputBox(dom.window.document.body, {
		type: 'number',
		presentation: 'field',
	});

	assert.equal(inputBox.inputElement.type, 'number');
	inputBox.step = '1';
	assert.equal(inputBox.step, '1');
	assert.equal(inputBox.element.classList.contains('ash-input-box-field'), true);
	dom.window.close();
});

test('HistoryInputBox navigates saved values and restores the uncommitted input', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const inputBox = new HistoryInputBox(dom.window.document.body, {
		history: new Set(['first', 'second']),
		showHistoryHint: () => true,
	});
	inputBox.value = 'draft';
	inputBox.focus();
	assert.equal(inputBox.inputElement.getAttribute('aria-keyshortcuts'), 'ArrowUp ArrowDown');
	inputBox.showPreviousValue();
	assert.equal(inputBox.value, 'second');
	inputBox.showPreviousValue();
	assert.equal(inputBox.value, 'first');
	inputBox.showNextValue();
	inputBox.showNextValue();
	assert.equal(inputBox.value, 'draft');

	inputBox.showPreviousValue();
	inputBox.value = 'edited';
	inputBox.showNextValue();
	assert.equal(inputBox.value, 'edited');
	inputBox.addToHistory();
	assert.deepEqual(inputBox.getHistory(), ['first', 'second', 'edited']);
	inputBox.dispose();
	dom.window.close();
});
