import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ModelCard } from '../../browser/widget/input/modelPicker/modelPickerCard.js';
import type { ModelReasoningEffort } from '../../../../services/chat/common/modelCatalog.js';

test('ModelCard derives detached controls from its host and sends reasoning effort changes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	try {
		const container = dom.window.document.querySelector('main')!;
		const selected: (ModelReasoningEffort | undefined)[] = [];
		using card = new ModelCard(container, {
			entry: { model: { provider: 'test', model: 'model' }, displayName: 'Test model', supportedReasoningEfforts: ['low', 'high'] },
			selectedEffort: 'low',
			selectReasoningEffort: async effort => { selected.push(effort); },
		});
		assert.equal(card.domNode.ownerDocument, container.ownerDocument);
		assert.equal(card.domNode.isConnected, false);
		container.append(card.domNode);
		card.focus(container);
		assert.equal(dom.window.document.activeElement, card.domNode.querySelector('input[value="low"]'));
		const high = card.domNode.querySelector<HTMLInputElement>('input[value="high"]')!;
		high.click();
		await Promise.resolve();
		assert.deepEqual(selected, ['high']);
	} finally {
		dom.window.close();
	}
});
