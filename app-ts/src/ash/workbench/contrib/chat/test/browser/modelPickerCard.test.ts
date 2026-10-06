import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ModelPreferencesUpdate } from '../../../../../platform/sessions/common/sessionApi.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ModelCard } from '../../browser/widget/input/modelPicker/modelPickerCard.js';

const environment = new JSDOM('<!doctype html><body></body>');
suiteTeardown(() => environment.window.close());
const entry: ModelCatalogEntry = {
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	contextWindow: 272_000, longContext: false, maximumContextWindow: 872_000, accelerationOptions: [{ id: "priority", name: "Fast", description: "" }], selectedAcceleration: null,
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
	const context = card.domNode.querySelector<HTMLInputElement>('input[aria-label="Long context"]')!;
	fast.focus();
	fast.click();
	context.click();
	assert.deepEqual(calls, [{ acceleration: 'priority' }]);
	const completed = saved(card);
	rejectSave(new Error('Save failed'));
	await completed;
	assert.deepEqual({ checked: fast.checked, error: card.domNode.querySelector('[role="status"]')?.textContent, focused: document.activeElement === fast }, {
		checked: false, error: 'Could not update model settings', focused: true,
	});
});

test('Model card saves long context while retaining both switches across catalog refreshes', async () => {
	const document = environment.window.document;
	const calls: ModelPreferencesUpdate[] = [];
	using card = new ModelCard(document);
	const setPreferences = async (update: ModelPreferencesUpdate): Promise<void> => {
		calls.push(update);
		card.update({ entry: { ...entry, longContext: update.longContext! }, setPreferences });
	};
	card.update({ entry, setPreferences });
	document.body.append(card.domNode);
	const inputs = [...card.domNode.querySelectorAll<HTMLInputElement>('input')];
	assert.equal(card.domNode.textContent, 'FastLong context');
	inputs[1].focus();
	const completed = saved(card);
	inputs[1].click();
	await completed;
	assert.deepEqual(calls, [{ longContext: true }]);
	assert.equal(card.domNode.textContent, 'FastLong context');
	assert.equal(inputs[1].checked, true);
	assert.equal(document.activeElement, inputs[1]);
	assert.deepEqual([...card.domNode.querySelectorAll('input')], inputs);
});

test('Model card hides fixed capacity and disables unsupported preferences', () => {
	using card = new ModelCard(environment.window.document);
	card.update({ entry: { ...entry, contextWindow: 500_000, longContext: null, maximumContextWindow: 500_000, accelerationOptions: [] }, setPreferences: async () => { } });
	assert.equal(card.domNode.querySelector('input[aria-label="Fast"]'), null);
	assert.equal((card.domNode.querySelector('.ash-chat-model-card-context') as HTMLElement).hidden, true);
	assert.equal(card.domNode.textContent, '');
	assert.equal(card.domNode.querySelectorAll('[role="radio"]').length, 0);
});


test('Model card uses the backend boolean independently of numeric capacity', async () => {
	using card = new ModelCard(environment.window.document);
	const calls: ModelPreferencesUpdate[] = [];
	let current = { ...entry, contextWindow: 256_000, longContext: false, maximumContextWindow: 2_000_000 };
	const setPreferences = async (update: ModelPreferencesUpdate): Promise<void> => {
		calls.push(update);
		current = { ...current, longContext: update.longContext! };
		card.update({ entry: current, setPreferences });
	};
	card.update({ entry: current, setPreferences });
	environment.window.document.body.append(card.domNode);
	const input = card.domNode.querySelector<HTMLInputElement>('input[aria-label="Long context"]')!;
	assert.equal(card.domNode.textContent, 'FastLong context');
	let completed = saved(card);
	input.click();
	await completed;
	assert.equal(input.checked, true);
	completed = saved(card);
	input.click();
	await completed;
	assert.deepEqual(calls, [{ longContext: true }, { longContext: false }]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Model card exposes catalog acceleration copy and its accessible description in ${locale}`, () => {
		const catalog = builtinLanguagePackCatalogs.find(item => item.locale === locale)!;
		setNlsMessages(locale, catalog.bundles);
		try {
			using card = new ModelCard(environment.window.document);
			card.update({ entry: { ...entry, accelerationOptions: [{ id: 'priority', name: 'Fast', description: 'Faster responses, increased usage' }] }, setPreferences: async () => { } });
			const input = card.domNode.querySelector<HTMLInputElement>('input')!;
			const description = locale === 'zh-CN' ? '响应更快，用量增加' : 'Faster responses, increased usage';
			assert.equal(input.getAttribute('aria-label'), locale === 'zh-CN' ? '快速' : 'Fast');
			assert.equal(input.getAttribute('aria-description'), description);
			assert.equal(card.domNode.querySelector('.ash-chat-model-card-description')!.textContent, description);
			assert.equal(input.checked, false);
		} finally { resetNlsResolver(); }
	});
}

test('Model card selects one acceleration option and removes denied controls without replacing retained inputs', async () => {
	const document = environment.window.document;
	const calls: ModelPreferencesUpdate[] = [];
	using card = new ModelCard(document);
	let current = {
		...entry, accelerationOptions: [
			{ id: 'priority', name: 'Fast', description: 'Priority processing, increased usage' },
			{ id: 'ultrafast', name: 'Ultra Fast', description: 'Fastest processing' },
		]
	};
	const setPreferences = async (update: ModelPreferencesUpdate): Promise<void> => {
		calls.push(update);
		current = { ...current, selectedAcceleration: update.acceleration! };
		card.update({ entry: current, setPreferences });
	};
	card.update({ entry: current, setPreferences });
	document.body.append(card.domNode);
	const fast = card.domNode.querySelector<HTMLInputElement>('input[aria-label="Fast"]')!;
	const ultra = card.domNode.querySelector<HTMLInputElement>('input[aria-label="Ultra Fast"]')!;
	let completed = saved(card);
	fast.click();
	await completed;
	assert.equal(fast.checked, true);
	ultra.focus();
	completed = saved(card);
	ultra.click();
	await completed;
	assert.equal(fast.checked, false);
	assert.equal(ultra.checked, true);
	assert.equal(document.activeElement, ultra);
	current = { ...current, accelerationOptions: [current.accelerationOptions[1]] };
	card.update({ entry: current, setPreferences });
	assert.equal(fast.isConnected, false);
	assert.equal(card.domNode.querySelector('input[aria-label="Ultra Fast"]'), ultra);
	assert.equal(document.activeElement, ultra);
	completed = saved(card);
	ultra.click();
	await completed;
	assert.deepEqual(calls, [{ acceleration: 'priority' }, { acceleration: 'ultrafast' }, { acceleration: null }]);
	assert.equal(ultra.checked, false);
});

test('An unavailable saved acceleration can be cleared when every option is denied', async () => {
	const document = environment.window.document;
	using card = new ModelCard(document);
	const setPreferences = async (update: ModelPreferencesUpdate): Promise<void> => {
		assert.deepEqual(update, { acceleration: null });
		card.update({ entry: { ...entry, accelerationOptions: [], selectedAcceleration: null }, setPreferences });
	};
	card.update({ entry: { ...entry, accelerationOptions: [], selectedAcceleration: 'priority' }, setPreferences });
	document.body.append(card.domNode);
	card.focus();
	const clear = card.domNode.querySelector<HTMLButtonElement>('button')!;
	assert.equal(clear.textContent, 'Turn off acceleration');
	assert.equal(document.activeElement, clear);
	const completed = saved(card);
	clear.click();
	await completed;
	assert.equal(clear.isConnected, false);
	assert.equal(document.activeElement, card.domNode.querySelector('input'));
});
