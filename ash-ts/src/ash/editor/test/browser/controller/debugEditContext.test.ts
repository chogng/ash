import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DebugEditContext } from '../../../browser/controller/editContext/native/debugEditContext.js';

test('DebugEditContext delegates browser state and clears its diagnostic markers', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	let browserContext: TestEditContext | undefined;
	const EventTarget = dom.window.EventTarget;

	class TestEditContext extends EventTarget {
		public text: string;
		public selectionStart: number;
		public selectionEnd: number;
		public characterBoundsRangeStart = 0;
		private bounds: DOMRect[] = [];

		constructor(options: { readonly text?: string; readonly selectionStart?: number; readonly selectionEnd?: number } = {}) {
			super();
			this.text = options.text ?? '';
			this.selectionStart = options.selectionStart ?? 0;
			this.selectionEnd = options.selectionEnd ?? 0;
			browserContext = this;
		}

		public updateText(start: number, end: number, text: string): void {
			this.text = this.text.slice(0, start) + text + this.text.slice(end);
		}

		public updateSelection(start: number, end: number): void {
			this.selectionStart = start;
			this.selectionEnd = end;
		}

		public updateControlBounds(_bounds: DOMRect): void {}
		public updateSelectionBounds(_bounds: DOMRect): void {}

		public updateCharacterBounds(rangeStart: number, bounds: DOMRect[]): void {
			this.characterBoundsRangeStart = rangeStart;
			this.bounds = bounds;
		}

		public attachedElements(): HTMLElement[] { return []; }
		public characterBounds(): DOMRect[] { return this.bounds; }
	}

	Object.defineProperty(dom.window, 'EditContext', { value: TestEditContext });
	const debug = new DebugEditContext(dom.window as unknown as Window, { text: 'draft', selectionStart: 1, selectionEnd: 3 });
	assert.ok(browserContext);
	assert.equal(debug.text, 'draft');
	assert.equal(debug.selectionStart, 1);
	assert.equal(debug.selectionEnd, 3);

	let updates = 0;
	const listener = () => updates += 1;
	const originalDebug = console.debug;
	console.debug = () => {};
	try {
		debug.addEventListener('textupdate', listener);
		browserContext.dispatchEvent(new dom.window.Event('textupdate'));
		assert.equal(updates, 1);

		debug.updateText(1, 3, 'X');
		debug.updateSelection(2, 2);
		debug.updateControlBounds(new dom.window.DOMRect(10, 20, 30, 40));
		debug.updateSelectionBounds(new dom.window.DOMRect(12, 24, 3, 18));
		debug.updateCharacterBounds(2, [new dom.window.DOMRect(14, 26, 6, 18)]);
		assert.equal(debug.text, 'dXft');
		assert.equal(debug.selectionStart, 2);
		assert.equal(debug.selectionEnd, 2);
		assert.equal(debug.characterBoundsRangeStart, 2);
		assert.equal(debug.characterBounds().length, 1);

		const markers = [...dom.window.document.querySelectorAll<HTMLElement>('.debug-rect-marker')];
		assert.equal(markers.length, 4);
		assert.ok(markers.every(marker => marker.getAttribute('aria-hidden') === 'true'));

		debug.endDebugging();
		assert.equal(dom.window.document.querySelectorAll('.debug-rect-marker').length, 0);
		debug.startDebugging();
		assert.equal(dom.window.document.querySelectorAll('.debug-rect-marker').length, 4);
		debug.removeEventListener('textupdate', listener);
		assert.equal(dom.window.document.querySelectorAll('.debug-rect-marker').length, 0);
	} finally {
		console.debug = originalDebug;
		dom.window.close();
	}
});
