import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import { TextAreaInput, type ITextAreaInputHost } from '../../../browser/controller/editContext/textArea/textAreaEditContextInput.js';
import { TextAreaState } from '../../../browser/controller/editContext/textArea/textAreaEditContextState.js';

function createHost(getScreenReaderContent: () => TextAreaState = () => TextAreaState.EMPTY): ITextAreaInputHost {
	return {
		context: {
			viewModel: {
				getSelections: () => [new Selection(1, 1, 1, 1)],
			},
		} as ITextAreaInputHost['context'],
		getScreenReaderContent,
		deduceModelPosition: (anchor, deltaOffset, lineFeedCount) => {
			assert.equal(lineFeedCount, 0);
			return new Position(anchor.lineNumber, anchor.column + deltaOffset);
		},
	};
}

test('textarea input owns direction-aware value and selection state', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	input.setValue('test', 'abcd');
	input.setSelectionRange('test', 3, 1);
	assert.equal(input.getValue(), 'abcd');
	assert.deepEqual([input.getSelectionStart(), input.getSelectionEnd()], [3, 1]);
	dom.window.close();
});

test('textarea input disconnects keyboard events on dispose', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	const input = new TextAreaInput(createHost(), element);
	const keys: string[] = [];
	let receivedBrowserEvent: KeyboardEvent | undefined;
	let receivedEvent: StandardKeyboardEvent | undefined;
	input.onKeyDown(event => {
		keys.push(`down:${event.key}`);
		receivedBrowserEvent = event.browserEvent;
		if (event instanceof StandardKeyboardEvent) receivedEvent = event;
	});
	input.onKeyUp(event => keys.push(`up:${event.key}`));
	const browserEvent = new dom.window.KeyboardEvent('keydown', { key: 'A' });
	element.dispatchEvent(browserEvent);
	element.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'A' }));
	assert.deepEqual(keys, ['down:A', 'up:A']);
	assert.ok(receivedEvent);
	assert.strictEqual(receivedBrowserEvent, browserEvent);

	input.dispose();
	element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'B' }));
	assert.deepEqual(keys, ['down:A', 'up:A']);
	dom.window.close();
});

test('textarea input publishes insertText through the standard type event', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	const order: string[] = [];
	input.onDidBeforeInput(() => order.push('beforeinput'));
	let typeData: { readonly text: string; readonly replacePrevCharCnt: number; } | undefined;
	input.onType(event => {
		order.push('type');
		typeData = event;
	});
	const browserEvent = new dom.window.InputEvent('beforeinput', {
		bubbles: true,
		cancelable: true,
		data: 'x',
		inputType: 'insertText',
	});
	element.focus();
	element.dispatchEvent(browserEvent);
	assert.equal(browserEvent.defaultPrevented, true);
	assert.deepEqual(order, ['beforeinput', 'type']);
	assert.deepEqual(typeData, {
		text: 'x',
		replacePrevCharCnt: 0,
		replaceNextCharCnt: 0,
		positionDelta: 0,
	});
	dom.window.close();
});

test('textarea input publishes normalized composition state', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	let composition: { readonly data: string; } | undefined;
	const types: unknown[] = [];
	const completed: unknown[] = [];
	input.onCompositionUpdate(event => composition = event);
	input.onType(event => types.push(event));
	input.onCompositionEnd(event => completed.push(event));
	element.focus();
	element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
	input.setValue('composition', 'first\nsecond');
	input.setSelectionRange('composition', 5, 5);
	element.dispatchEvent(new dom.window.CompositionEvent('compositionupdate', { data: 'x' }));
	element.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: 'first\r\nsecond' }));
	assert.deepEqual(composition, { data: 'x' });
	assert.deepEqual(types, [{
		text: 'first\nsecond',
		replacePrevCharCnt: 0,
		replaceNextCharCnt: 0,
		positionDelta: -7,
	}]);
	assert.deepEqual(completed, [{ data: 'first\nsecond' }]);
	dom.window.close();
});

test('textarea composition reads candidate text after the browser updates its value', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	const types: unknown[] = [];
	using listener = input.onType(event => types.push(event));
	element.focus();
	element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
	for (const text of ['ni', '你']) {
		element.dispatchEvent(new dom.window.CompositionEvent('compositionupdate', { data: text }));
		element.value = text;
		element.setSelectionRange(text.length, text.length);
		element.dispatchEvent(new dom.window.InputEvent('input', { data: text, inputType: 'insertCompositionText', isComposing: true }));
	}
	element.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: '你' }));
	assert.deepEqual(types, [
		{ text: 'ni', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0 },
		{ text: '你', replacePrevCharCnt: 2, replaceNextCharCnt: 0, positionDelta: 0 },
	]);
	dom.window.close();
});

test('textarea composition extracts candidates from the preserved native context', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	element.value = '前中文后';
	element.setSelectionRange(1, 3, 'backward');
	using input = new TextAreaInput(createHost(), element);
	const types: unknown[] = [];
	using listener = input.onType(event => types.push(event));
	element.focus();
	element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
	for (const [text, end] of [['ni', 3], ['你', 3]] as const) {
		element.setRangeText(text, 1, end, 'end');
		element.dispatchEvent(new dom.window.InputEvent('input', { data: text, inputType: 'insertCompositionText', isComposing: true }));
	}
	element.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: '你' }));
	assert.equal(element.value, '前你后');
	assert.deepEqual(types, [
		{ text: 'ni', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0 },
		{ text: '你', replacePrevCharCnt: 2, replaceNextCharCnt: 0, positionDelta: 0 },
	]);
	dom.window.close();
});

test('textarea composition accepts a system caret change after input', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	const types: unknown[] = [];
	using listener = input.onType(event => types.push(event));
	element.focus();
	element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
	element.value = '你好';
	element.setSelectionRange(2, 2);
	element.dispatchEvent(new dom.window.InputEvent('input', { data: '你好', inputType: 'insertCompositionText', isComposing: true }));
	element.setSelectionRange(1, 1);
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(types, [
		{ text: '你好', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0 },
		{ text: '', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: -1 },
	]);
	dom.window.close();
});

test('textarea composition replacements cover both sides of an internal IME caret', () => {
	const dom = new JSDOM('<textarea></textarea>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	const types: unknown[] = [];
	using listener = input.onType(event => types.push(event));
	element.focus();
	element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
	for (const [text, offset] of [['你好', 1], ['您好', 1], ['您们好', 3]] as const) {
		element.value = text;
		element.setSelectionRange(offset, offset);
		element.dispatchEvent(new dom.window.CompositionEvent('compositionupdate', { data: text }));
	}
	element.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: '您们好' }));
	assert.deepEqual(types, [
		{ text: '你好', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: -1 },
		{ text: '您好', replacePrevCharCnt: 1, replaceNextCharCnt: 1, positionDelta: -1 },
		{ text: '您们好', replacePrevCharCnt: 1, replaceNextCharCnt: 1, positionDelta: 0 },
	]);
	dom.window.close();
});

test('textarea input releases composition ownership on blur', () => {
	const dom = new JSDOM('<body><textarea></textarea></body>');
	const element = dom.window.document.querySelector('textarea')!;
	const screenReaderState = new TextAreaState('ready', 0, 0, new Selection(1, 1, 1, 1), 0);
	using input = new TextAreaInput(createHost(() => screenReaderState), element);
	let compositionStarts = 0;
	input.onCompositionStart(() => compositionStarts += 1);
	input.focusTextArea();
	element.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
	element.blur();
	const lateStart = new dom.window.CompositionEvent('compositionstart', { cancelable: true });
	element.dispatchEvent(lateStart);
	assert.deepEqual({ prevented: lateStart.defaultPrevented, compositionStarts }, { prevented: true, compositionStarts: 1 });
	input.focusTextArea();
	input.writeNativeTextAreaContent('refocus');
	assert.equal(element.value, 'ready');
	dom.window.close();
});

test('textarea input owns focus and reports the resulting focus state', () => {
	const dom = new JSDOM('<body><textarea></textarea></body>');
	const element = dom.window.document.querySelector('textarea')!;
	using input = new TextAreaInput(createHost(), element);
	input.focusTextArea();
	assert.equal(dom.window.document.activeElement, element);
	assert.equal(input.isFocused(), true);
	dom.window.close();
});

test('textarea input translates a focused system-caret move through its host and releases the listener on blur', () => {
	const dom = new JSDOM('<body><textarea></textarea></body>');
	const element = dom.window.document.querySelector('textarea')!;
	const screenReaderState = new TextAreaState(
		'abcd',
		1,
		3,
		new Selection(1, 2, 1, 4),
		0,
	);
	using input = new TextAreaInput(createHost(() => screenReaderState), element);
	const requests: Selection[] = [];
	input.onSelectionChangeRequest(selection => requests.push(selection));
	input.focusTextArea();
	input.writeNativeTextAreaContent('test');
	input.resetSelectionChangeTime();

	element.setSelectionRange(0, 2, 'forward');
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(requests, [new Selection(1, 1, 1, 3)]);

	element.blur();
	element.setSelectionRange(2, 4, 'forward');
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.equal(requests.length, 1);
	dom.window.close();
});
