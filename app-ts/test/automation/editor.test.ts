import assert from 'node:assert/strict';
import type { Locator } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Editor } from './editor.js';

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
