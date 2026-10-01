import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { IconSelectBox } from '../../browser/ui/icons/iconSelectBox.js';
import { Lxicon } from '../../common/lxicons.js';

test('IconSelectBox creates detached controls in its host document and preserves selection', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	try {
		const container = dom.window.document.querySelector('main')!;
		using box = new IconSelectBox(container, { icons: [Lxicon.add, Lxicon.check], showIconInfo: true });
		assert.equal(box.domNode.ownerDocument, container.ownerDocument);
		assert.equal(box.domNode.isConnected, false);
		container.append(box.domNode);
		const selected: string[] = [];
		using selection = box.onDidSelect(icon => selected.push(icon.id));
		box.setSelection(1);
		const input = box.domNode.querySelector('input')!;
		input.value = Lxicon.check.id;
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		assert.deepEqual({
			selected,
			options: [...box.domNode.querySelectorAll('[role="option"]')].map(option => ({ label: option.getAttribute('aria-label'), selected: option.getAttribute('aria-selected') })),
		}, {
			selected: [Lxicon.check.id],
			options: [{ label: Lxicon.check.id, selected: 'true' }],
		});
	} finally {
		dom.window.close();
	}
});
