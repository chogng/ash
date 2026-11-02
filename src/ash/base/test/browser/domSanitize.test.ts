import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { safeSetInnerHtml, sanitizeHtml, sanitizeHtmlToFragment } from '../../browser/domSanitize.js';

suite('Shared HTML sanitization', () => {
	test('removes executable markup while preserving supported content in HTML sinks', () => {
		const target = document.createElement('div');
		safeSetInnerHtml(target, '<p>Hello <strong>world</strong></p><script>alert(1)</script><img src="https://example.com/image.png" onerror="alert(1)"><svg><animate onbegin="alert(1)"></animate></svg>');
		assert.equal(target.querySelector('p')?.innerHTML, 'Hello <strong>world</strong>');
		assert.equal(target.querySelector('img')?.getAttribute('src'), 'https://example.com/image.png');
		assert.equal(target.querySelector('script,svg,[onerror],[onbegin]'), null);
		assert.equal(String(sanitizeHtml('<b onclick="alert(1)">Safe</b>')), '<b>Safe</b>');
	});

	test('checks link and media protocols independently', () => {
		const fragment = sanitizeHtmlToFragment(
			'<a href="command:run">Command</a><a href="javascript:alert(1)">Script</a><a href="#section">Section</a><img src="command:run"><img src="https://example.com/image.png">',
			{ ownerDocument: document, config: { allowedLinkProtocols: { override: ['command'] } } },
		);
		assert.deepEqual([...fragment.querySelectorAll('a')].map(link => link.getAttribute('href')), ['command:run', null, '#section']);
		assert.deepEqual([...fragment.querySelectorAll('img')].map(image => image.getAttribute('src')), [null, 'https://example.com/image.png']);
	});

	test('rechecks URLs rewritten by attribute hooks', () => {
		const fragment = sanitizeHtmlToFragment('<a href="https://example.com">Link</a>', {
			ownerDocument: document,
			config: {
				allowedAttributes: {
					override: [{ attributeName: 'href', shouldKeep: () => 'javascript:alert(1)' }],
				},
			},
		});
		assert.equal(fragment.querySelector('a')?.getAttribute('href'), null);
		assert.equal(fragment.textContent, 'Link');
	});

	test('keeps attribute hooks isolated between calls and destination documents', () => {
		const auxiliary = new JSDOM('<!doctype html><body></body>');
		try {
			safeSetInnerHtml(auxiliary.window.document.body, '<p title="original">Content</p>', {
				allowedAttributes: {
					override: [{ attributeName: 'title', shouldKeep: () => 'rewritten' }],
				},
			});
			const paragraph = auxiliary.window.document.querySelector('p');
			assert.equal(paragraph?.ownerDocument, auxiliary.window.document);
			assert.equal(paragraph?.getAttribute('title'), 'rewritten');
			for (const ownerDocument of [auxiliary.window.document, document]) {
				const target = ownerDocument.createElement('div');
				safeSetInnerHtml(target, '<p title="original">Content</p>');
				assert.equal(target.querySelector('p')?.ownerDocument, ownerDocument);
				assert.equal(target.querySelector('p')?.getAttribute('title'), 'original');
			}
		} finally {
			auxiliary.window.close();
		}
	});

	test('renders rejected media as literal text without creating active markup', () => {
		const fragment = sanitizeHtmlToFragment('<p>Content</p><img src="https://blocked.example/image.png" onerror="alert(1)">', {
			ownerDocument: document,
			config: { mediaSourceIsAllowed: () => false, replaceWithPlaintext: true },
		});
		assert.equal(fragment.querySelector('p')?.textContent, 'Content');
		assert.equal(fragment.querySelector('img,[onerror]'), null);
		assert.match(fragment.textContent ?? '', /<img src="https:\/\/blocked\.example\/image\.png">/u);
	});
});
