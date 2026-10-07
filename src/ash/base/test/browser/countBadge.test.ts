import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { CountBadge } from '../../browser/ui/countBadge/countBadge.js';
import { setHoverDelegate, type IManagedHover } from '../../browser/ui/hover/hoverDelegate.js';

suite('CountBadge', () => {
	test('updates its count, accessible description and hover together, then releases them', () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		const descriptions: string[] = [];
		let disposed = false;
		using hoverDelegate = setHoverDelegate({
			setupDelayedHover: () => { throw new Error('Unexpected delayed hover'); },
			setupHover: () => ({
				visible: false,
				show() { },
				hide() { },
				update: content => { descriptions.push(String(content)); },
				dispose: () => { disposed = true; },
				[Symbol.dispose](): void { this.dispose(); },
			} satisfies IManagedHover),
		});
		try {
			using badge = new CountBadge(browser.window.document.body, { count: 6, titleFormat: '{0} changes' });
			assert.deepEqual({ text: badge.domNode.textContent, description: badge.domNode.getAttribute('aria-label') }, { text: '6', description: '6 changes' });
			const root = badge.domNode;
			badge.setCount(1234);
			assert.equal(badge.domNode, root);
			assert.deepEqual({ text: root.textContent, description: root.getAttribute('aria-label') }, { text: '1234', description: '1234 changes' });
			badge.setCount(0);
			assert.deepEqual(descriptions, ['6 changes', '1234 changes', '0 changes']);
			badge.dispose();
			assert.equal(disposed, true);
			assert.equal(browser.window.document.body.childElementCount, 0);
		} finally {
			browser.window.close();
		}
	});

	test('renders plain counts and custom count formats without adding a focus target', () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		try {
			using plain = new CountBadge(browser.window.document.body);
			using formatted = new CountBadge(browser.window.document.body, { count: 12, countFormat: '({0})' });
			assert.deepEqual({ plain: plain.domNode.textContent, formatted: formatted.domNode.textContent, tabIndex: plain.domNode.tabIndex }, { plain: '0', formatted: '(12)', tabIndex: -1 });
		} finally {
			browser.window.close();
		}
	});
});
