import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ModelPreferencesUpdate } from '../../../../../platform/sessions/common/sessionApi.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ModelCard } from '../../browser/widget/input/modelPicker/modelPickerCard.js';

const environment = new JSDOM('<!doctype html><body></body>');
suiteTeardown(() => environment.window.close());
const entry: ModelCatalogEntry = {
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	contextWindow: 272_000, maximumContextWindow: 1_050_000, supportsFast: true, fast: false,
};

function saved(card: ModelCard): Promise<void> {
	return new Promise(resolve => {
		const observer = new environment.window.MutationObserver(() => {
			if (!card.domNode.hasAttribute('aria-busy')) { observer.disconnect(); resolve(); }
		});
		observer.observe(card.domNode, { attributes: true, attributeFilter: ['aria-busy'] });
	});
}

test('Model card prevents overlapping saves and restores the stored setting and focus after failure', async () => {
	const document = environment.window.document;
	let rejectSave!: (error: Error) => void;
	const calls: ModelPreferencesUpdate[] = [];
	const pending = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
	using card = new ModelCard(document);
	card.update({ entry, setPreferences: update => { calls.push(update); return pending; } });
	document.body.append(card.domNode);
	const fast = card.domNode.querySelector<HTMLInputElement>('input[aria-label="Fast"]')!;
	const context = card.domNode.querySelector<HTMLInputElement>('input[aria-label="1M context"]')!;
	fast.focus();
	fast.click();
	context.click();
	assert.deepEqual(calls, [{ fast: true }]);
	const completed = saved(card);
	rejectSave(new Error('Save failed'));
	await completed;
	assert.deepEqual({ checked: fast.checked, error: card.domNode.querySelector('[role="status"]')?.textContent, focused: document.activeElement === fast }, {
		checked: false, error: 'Could not update model settings', focused: true,
	});
});

test('Model card saves the context window while retaining both switches across catalog refreshes', async () => {
	const document = environment.window.document;
	const calls: ModelPreferencesUpdate[] = [];
	using card = new ModelCard(document);
	const setPreferences = async (update: ModelPreferencesUpdate): Promise<void> => {
		calls.push(update);
		card.update({ entry: { ...entry, contextWindow: update.contextWindow }, setPreferences });
	};
	card.update({ entry, setPreferences });
	document.body.append(card.domNode);
	const inputs = [...card.domNode.querySelectorAll<HTMLInputElement>('input')];
	assert.equal(card.domNode.textContent, 'Fast272k');
	inputs[1].focus();
	const completed = saved(card);
	inputs[1].click();
	await completed;
	assert.deepEqual(calls, [{ contextWindow: 1_000_000 }]);
	assert.equal(card.domNode.textContent, 'Fast1M');
	assert.equal(inputs[1].checked, true);
	assert.equal(document.activeElement, inputs[1]);
	assert.deepEqual([...card.domNode.querySelectorAll('input')], inputs);
});

test('Model card hides fixed capacity and disables unsupported preferences', () => {
	using card = new ModelCard(environment.window.document);
	card.update({ entry: { ...entry, contextWindow: 500_000, maximumContextWindow: 500_000, supportsFast: false }, setPreferences: async () => {} });
	assert.equal(card.domNode.querySelector<HTMLInputElement>('input[aria-label="Fast"]')!.disabled, true);
	assert.equal((card.domNode.querySelector('.ash-chat-model-card-context') as HTMLElement).hidden, true);
	assert.equal(card.domNode.textContent, 'Fast');
	assert.equal(card.domNode.querySelectorAll('[role="radio"]').length, 0);
});
