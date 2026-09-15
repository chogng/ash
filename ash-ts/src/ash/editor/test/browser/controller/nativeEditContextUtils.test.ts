import { h } from '../../../../base/browser/dom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { EditContext } from '../../../browser/controller/editContext/native/editContextFactory.js';
import { clampOffset, createNativeTextWindow, FocusTracker, isNativeTextUpdateEvent, NATIVE_TEXT_WINDOW_LENGTH } from '../../../browser/controller/editContext/native/nativeEditContextUtils.js';
import { NullLoggerService } from '../../../../platform/log/common/log.js';

test('native edit-context offsets are clamped and validated', () => {
	assert.equal(clampOffset(-4, 10), 0);
	assert.equal(clampOffset(20, 10), 10);
	assert.equal(isNativeTextUpdateEvent({ text: 'x', updateRangeStart: 0, updateRangeEnd: 1 }), true);
	assert.equal(isNativeTextUpdateEvent({ text: 'x', updateRangeStart: -1, updateRangeEnd: 1 }), false);
});

test('native text window remains bounded around the selection', () => {
	const text = 'a'.repeat(NATIVE_TEXT_WINDOW_LENGTH * 2);
	const window = createNativeTextWindow(text, NATIVE_TEXT_WINDOW_LENGTH, NATIVE_TEXT_WINDOW_LENGTH);
	assert.equal(window.endOffset - window.startOffset, NATIVE_TEXT_WINDOW_LENGTH);
	assert.ok(window.startOffset <= NATIVE_TEXT_WINDOW_LENGTH && window.endOffset >= NATIVE_TEXT_WINDOW_LENGTH);
});

test('edit-context factory owns browser object construction and reports missing support', () => {
	class TestEditContext extends EventTarget {
		readonly text = '';
		readonly selectionStart = 0;
		readonly selectionEnd = 0;
		constructor(readonly options?: unknown) { super(); }
		updateText(): void {}
		updateSelection(): void {}
	}
	const options = { text: 'draft', selectionStart: 1, selectionEnd: 1 };
	const instance = EditContext.create({ EditContext: TestEditContext } as unknown as Window, options);
	assert.equal((instance as TestEditContext).options, options);
	assert.throws(() => EditContext.create({} as Window), /unavailable/);
});

test('focus tracker validates the active element and keeps pause transitions silent', () => {
	const dom = new JSDOM('<button id="before"></button><div id="input" tabindex="0"></div>');
	const input = dom.window.document.querySelector<HTMLElement>('#input')!;
	const before = dom.window.document.querySelector<HTMLElement>('#before')!;
	const changes: boolean[] = [];
	const traces: string[] = [];
	class RecordingLogService extends NullLoggerService {
		override trace(message: string): void { traces.push(message); }
	}
	using tracker = new FocusTracker(new RecordingLogService(), input, focused => changes.push(focused));

	tracker.focus();
	assert.equal(tracker.isFocused, true);
	tracker.pause();
	before.focus();
	assert.equal(tracker.isFocused, true);
	assert.deepEqual(changes, [true]);
	tracker.resume();
	assert.equal(tracker.isFocused, false);
	assert.deepEqual(changes, [true, false]);
	assert.deepEqual(traces, ['NativeEditContext.focus', 'NativeEditContext.blur']);
	tracker.dispose();
	input.focus();
	assert.deepEqual(traces, ['NativeEditContext.focus', 'NativeEditContext.blur']);
	dom.window.close();
});

test('focus tracker resolves the active element inside a shadow root', () => {
	const dom = new JSDOM('<main></main>');
	const host = dom.window.document.querySelector<HTMLElement>('main')!;
	const shadowRoot = host.attachShadow({ mode: 'open' });
	const input = h(dom.window.document, 'div');
	input.tabIndex = 0;
	shadowRoot.append(input);
	const changes: boolean[] = [];
	using tracker = new FocusTracker(new NullLoggerService(), input, focused => changes.push(focused));

	tracker.focus();
	assert.strictEqual(shadowRoot.activeElement, input);
	assert.equal(tracker.isFocused, true);
	assert.deepEqual(changes, [true]);
	dom.window.close();
});
