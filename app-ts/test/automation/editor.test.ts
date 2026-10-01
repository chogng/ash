import assert from 'node:assert/strict';
import type { Locator } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { runInNewContext } from 'node:vm';
import { Editor, measureRenderedTextRanges } from './editor.js';

suite('Rendered editor text geometry', () => {
	test('serialized measurement spans split tokens, nested decorations, boundaries and UTF-16 characters without changing selection', () => {
		const dom = new JSDOM('<!doctype html><div id="line"><span>session</span><span> rename &gt; </span><span><b>selected</b> content</span><span>🙂</span></div>');
		try {
			const line = dom.window.document.getElementById('line')!;
			const selection = dom.window.getSelection()!;
			selection.selectAllChildren(line);
			const markup = line.innerHTML;
			const measured: string[] = [];
			dom.window.Range.prototype.getBoundingClientRect = function (): DOMRect {
				measured.push(this.toString());
				return { left: measured.length, top: 2, width: 3, height: 4 } as DOMRect;
			};
			const evaluate = runInNewContext(`(${measureRenderedTextRanges.toString()})`) as typeof measureRenderedTextRanges;
			const rects = evaluate(line, [{ start: 17, end: 33 }, { start: 7, end: 17 }, { start: 33, end: 35 }, { start: 35, end: 35 }]);
			assert.deepEqual(measured, ['selected content', ' rename > ', '🙂', '']);
			assert.equal(JSON.stringify(rects), JSON.stringify([1, 2, 3, 4].map(left => ({ left, top: 2, width: 3, height: 4 }))));
			assert.equal(line.innerHTML, markup);
			assert.equal(selection.toString(), line.textContent);
		} finally {
			dom.window.close();
		}
	});

	test('missing and reversed offsets fail rather than clamping to unrelated text', () => {
		const dom = new JSDOM('<!doctype html><div><span>short</span></div>');
		try {
			const line = dom.window.document.querySelector('div')!;
			assert.throws(() => measureRenderedTextRanges(line, [{ start: 17, end: 17 }]), /offset 17 exceeds line length 5/u);
			assert.throws(() => measureRenderedTextRanges(line, [{ start: 4, end: 2 }]), /Invalid rendered text range 4:2/u);
		} finally {
			dom.window.close();
		}
	});
});

suite('Text editor automation focus', () => {
	test('observing focus never moves it from another control into the editor', async () => {
		const fixture = createFixture();
		try {
			await assert.rejects(fixture.editor.waitForEditorFocus(), /toBeFocused/u);
			assert.equal(fixture.document.activeElement, fixture.other);
			fixture.input.focus();
			await fixture.editor.waitForEditorFocus();
			assert.equal(fixture.document.activeElement, fixture.input);
		} finally {
			fixture.dispose();
		}
	});

	test('the explicit focus action focuses the editor and verifies the result', async () => {
		const fixture = createFixture();
		try {
			await fixture.editor.focus();
			assert.equal(fixture.document.activeElement, fixture.input);
		} finally {
			fixture.dispose();
		}
	});
});

function createFixture() {
	const dom = new JSDOM('<!doctype html><button id="other"></button><div id="content"><div class="stanza-editor"><textarea class="stanza-editor-input"></textarea></div></div>');
	const document = dom.window.document;
	const other = document.getElementById('other')!;
	const input = document.querySelector<HTMLTextAreaElement>('.stanza-editor-input')!;
	other.focus();
	return { document, other, input, editor: new Editor(new DomLocator('#content', document) as unknown as Locator), dispose: () => dom.window.close() };
}

class DomLocator {
	public readonly _apiName = 'Locator';

	constructor(private readonly selector: string, private readonly document: Document) {}

	public locator(selector: string): DomLocator {
		return new DomLocator(`${this.selector} ${selector.replace(':visible', '')}`, this.document);
	}

	public async focus(): Promise<void> {
		this.document.querySelector<HTMLElement>(this.selector)!.focus();
	}

	public async _expect(expression: string): Promise<{ matches: boolean; received: { value: string }; log: string[] }> {
		assert.ok(expression === 'to.be.visible' || expression === 'to.be.focused');
		const element = this.document.querySelector<HTMLElement>(this.selector)!;
		const matches = expression === 'to.be.visible' ? !element.hidden : expression === 'to.be.focused' && this.document.activeElement === element;
		return { matches, received: { value: matches ? 'matched' : 'not focused' }, log: [] };
	}
}
