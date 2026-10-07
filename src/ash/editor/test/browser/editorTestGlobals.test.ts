import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { installEditorTestDom } from './editorTestGlobals.js';

test('editor DOM globals install only selected constructors and restore their descriptors', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const names = ['window', 'document', 'Event', 'MouseEvent'];
	const before = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
	try {
		using installed = installEditorTestDom(dom, ['Event']);
		assert.strictEqual(globalThis.window, dom.window);
		assert.strictEqual(globalThis.document, dom.window.document);
		assert.strictEqual(globalThis.Event, dom.window.Event);
		assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent'), before[3]);
	} finally {
		dom.window.close();
	}
	assert.deepEqual(names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), before);
});
