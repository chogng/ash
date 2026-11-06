import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ArtifactButtons } from '../../browser/artifactButtons.js';

test('Artifact buttons keep the focused control and use the latest action after reordering', () => {
	const dom = new JSDOM('<div></div>');
	using window = toDisposable(() => dom.window.close());
	const document = dom.window.document;
	const container = document.querySelector('div')!;
	using buttons = new ArtifactButtons(container);
	const cancel = { id: 'cancel', label: 'Cancel', run: () => assert.fail('A disabled action must not run') };
	buttons.update([
		cancel,
		{ id: 'review', label: 'Review', run: () => assert.fail('The previous action must not run') },
	]);
	const review = container.querySelectorAll('button')[1]!;
	review.focus();
	let invoked: HTMLElement | undefined;
	buttons.update([
		{ id: 'review', label: 'Review changes', description: 'Open the reviewed changes', run: target => { invoked = target; } },
		{ ...cancel, enabled: false },
	]);
	const [updated, disabled] = container.querySelectorAll('button');
	assert.equal(updated, review);
	assert.equal(document.activeElement, review);
	assert.equal(review.textContent, 'Review changes');
	assert.equal(document.getElementById(review.getAttribute('aria-describedby')!)?.textContent, 'Open the reviewed changes');
	disabled.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	review.click();
	assert.equal(invoked, review);
	buttons.update([]);
	assert.equal(container.hidden, true);
	assert.equal(review.isConnected, false);
});
