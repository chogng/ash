import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ModelCard } from '../../browser/widget/input/modelPicker/modelPickerCard.js';

const environment = new JSDOM('<!doctype html><body></body>');
suiteTeardown(() => environment.window.close());

test('Model card rejects overlapping saves and retains the saved level after a failed change', async () => {
	const document = environment.window.document;
	const entry: ModelCatalogEntry = {
		model: { provider: 'openai', model: 'test-model' },
		displayName: 'Test Model',
		modelReasoningEffort: 'medium',
		supportedReasoningEfforts: ['low', 'medium', 'high'],
	};
	let rejectSave!: (error: Error) => void;
	let calls = 0;
	const pending = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
	using card = new ModelCard(document);
	card.update({ entry, selectedEffort: undefined, selectReasoningEffort: () => { calls++; return pending; } });
	document.body.append(card.domNode);
	const defaultChoice = card.domNode.querySelector<HTMLInputElement>('input[value=""]')!;
	const high = card.domNode.querySelector<HTMLInputElement>('input[value="high"]')!;
	const low = card.domNode.querySelector<HTMLInputElement>('input[value="low"]')!;
	high.focus();
	high.click();
	low.click();
	assert.equal(calls, 1);
	const completed = new Promise<void>(resolve => {
		const observer = new environment.window.MutationObserver(() => {
			if (!card.domNode.hasAttribute('aria-busy')) { observer.disconnect(); resolve(); }
		});
		observer.observe(card.domNode, { attributes: true, attributeFilter: ['aria-busy'] });
	});
	rejectSave(new Error('Save failed'));
	await completed;
	assert.deepEqual({ checked: defaultChoice.checked, error: card.domNode.querySelector('[role="status"]')?.textContent, focused: document.activeElement === high }, {
		checked: true, error: 'Could not set thinking effort', focused: true,
	});
});
