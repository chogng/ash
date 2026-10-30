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
			const host = browser.window.document.createElement('span');
			host.id = 'changes';
			host.setAttribute('aria-hidden', 'true');
			browser.window.document.body.append(host);
			using badge = new CountBadge(host, { count: 6, titleFormat: '{0} changes' });
			const root = host.querySelector<HTMLElement>('.ash-count-badge')!;
			assert.deepEqual({ text: root.textContent, description: root.getAttribute('aria-label') }, { text: '6', description: '6 changes' });
			badge.setCount(1234);
			assert.equal(host.querySelector('.ash-count-badge'), root);
			assert.deepEqual({ text: root.textContent, description: root.getAttribute('aria-label') }, { text: '1234', description: '1234 changes' });
			badge.setCount(0);
			assert.deepEqual(descriptions, ['6 changes', '1234 changes', '0 changes']);
			badge.dispose();
			assert.equal(disposed, true);
			assert.equal(host.childElementCount, 0);
			assert.equal(browser.window.document.body.firstElementChild, host);
			assert.equal(host.id, 'changes');
			assert.equal(host.getAttribute('aria-hidden'), 'true');
		} finally {
			browser.window.close();
		}
	});

	test('renders plain counts and custom count formats without adding a focus target', () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		try {
			using plain = new CountBadge(browser.window.document.body);
			using formatted = new CountBadge(browser.window.document.body, { count: 12, countFormat: '({0})' });
			const roots = browser.window.document.body.querySelectorAll<HTMLElement>('.ash-count-badge');
			assert.deepEqual({ plain: roots[0]!.textContent, formatted: roots[1]!.textContent, tabIndex: roots[0]!.tabIndex }, { plain: '0', formatted: '(12)', tabIndex: -1 });
		} finally {
			browser.window.close();
		}
	});
});
