import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { createChatPillHover } from '../../browser/chatPillHover.js';

test('chat pill hover creates and releases a separate preview for each opening', () => {
	const { window } = new JSDOM();
	try {
		let revision = 0;
		const disposed: number[] = [];
		const content = createChatPillHover({
			fallback: 'Image',
			sizing: 'preview',
			createContent: () => {
				const opening = ++revision;
				const element = window.document.createElement('div');
				element.textContent = String(opening);
				return { element, disposable: toDisposable(() => disposed.push(opening)) };
			},
		});
		assert.equal(content(CancellationToken.None), 'Image');
		assert.equal(content(CancellationToken.Cancelled), undefined);
		assert.equal(revision, 0);

		using first = new CancellationTokenSource();
		const firstView = content(first.token);
		assert.ok(firstView && typeof firstView !== 'string');
		assert.equal(firstView.textContent, '1');
		assert.ok(firstView.classList.contains('preview-sized'));
		first.cancel();
		assert.deepEqual(disposed, [1]);

		using second = new CancellationTokenSource();
		const secondView = content(second.token);
		assert.ok(secondView && typeof secondView !== 'string');
		assert.equal(secondView.textContent, '2');
		assert.notEqual(secondView, firstView);
		second.cancel();
		assert.deepEqual(disposed, [1, 2]);
	} finally {
		window.close();
	}
});
