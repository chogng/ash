import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { captureDocumentStyles, compareDocumentStyles } from '../../../../../test/fixtures/documentStyles.js';

suite('Document style isolation guard', () => {
	for (const tag of ['style', 'link']) {
		test(`detects a leftover ${tag} and accepts removal of the test-owned node`, () => {
			const dom = new JSDOM('<!doctype html><head></head><body></body>');
			try {
				const document = dom.window.document;
				const before = captureDocumentStyles(document.documentElement);
				const node = document.createElement(tag);
				if (node instanceof dom.window.HTMLLinkElement) node.rel = 'stylesheet';
				else node.textContent = '.katex { color: red; }';
				document.head.append(node);
				assert.ok(compareDocumentStyles(before, captureDocumentStyles(document.documentElement)).includes('stylesheet nodes changed'));
				node.remove();
				assert.deepEqual(compareDocumentStyles(before, captureDocumentStyles(document.documentElement)), []);
			} finally {
				dom.window.close();
			}
		});
	}

	test('detects replacement by an identical style node', () => {
		const dom = new JSDOM('<!doctype html><head><style>.katex { color: red; }</style></head><body></body>');
		try {
			const document = dom.window.document;
			const before = captureDocumentStyles(document.documentElement);
			const style = document.querySelector('style')!;
			style.replaceWith(style.cloneNode(true));
			const changes = compareDocumentStyles(before, captureDocumentStyles(document.documentElement));
			assert.ok(changes.includes('stylesheet nodes changed'));
			assert.ok(changes.includes('stylesheet identities changed'));
			assert.equal(changes.includes('stylesheet markup changed'), false);
		} finally {
			dom.window.close();
		}
	});

	test('detects CSSOM rule changes without a change to style markup', () => {
		const dom = new JSDOM('<!doctype html><head><style>.katex { color: red; }</style></head><body></body>');
		try {
			const document = dom.window.document;
			const before = captureDocumentStyles(document.documentElement);
			const sheet = document.styleSheets[0];
			sheet.insertRule('.leaked { display: none; }', sheet.cssRules.length);
			assert.deepEqual(compareDocumentStyles(before, captureDocumentStyles(document.documentElement)), ['stylesheet rules changed']);
			sheet.deleteRule(sheet.cssRules.length - 1);
			assert.deepEqual(compareDocumentStyles(before, captureDocumentStyles(document.documentElement)), []);
		} finally {
			dom.window.close();
		}
	});

	test('detects root and body inline style changes', () => {
		const dom = new JSDOM('<!doctype html><head></head><body></body>');
		try {
			const document = dom.window.document;
			const before = captureDocumentStyles(document.documentElement);
			document.documentElement.style.setProperty('--test-color', 'red');
			document.body.style.color = 'blue';
			assert.deepEqual(compareDocumentStyles(before, captureDocumentStyles(document.documentElement)), ['root inline style changed', 'body inline style changed']);
		} finally {
			dom.window.close();
		}
	});
});
