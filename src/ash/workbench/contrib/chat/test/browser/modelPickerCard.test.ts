import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ModelCard, type IModelCardOptions } from '../../browser/widget/input/modelPicker/modelPickerCard.js';
import { ModelPickerDetailsMenu } from '../../browser/widget/input/modelPicker/modelPickerHover.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';

const environment = new JSDOM('<!doctype html><body></body>');
const services = new InstantiationService();
services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
setIconResolver(environment.window.document, icon => getIconDefinition(icon));
suiteTeardown(() => services.dispose());
suiteTeardown(() => environment.window.close());
const entry: ModelCatalogEntry = {
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	description: 'For demanding coding tasks.\nSupports images and tools.',
	longContext: false, accelerationOptions: [{ id: 'priority', name: 'Fast', description: 'Faster responses, increased usage' }],
};

test('Model card displays the provider description verbatim and exposes it to keyboard users', () => {
	using card = services.createInstance(ModelCard, environment.window.document, undefined);
	card.update(entry);
	environment.window.document.body.append(card.domNode);
	card.focus();
	assert.deepEqual({
		text: card.domNode.textContent?.trim(), label: card.domNode.getAttribute('aria-label'),
		description: card.domNode.getAttribute('aria-description'), focused: environment.window.document.activeElement === card.domNode,
		controls: card.domNode.querySelectorAll('input, button').length,
	}, { text: entry.description, label: entry.displayName, description: entry.description, focused: true, controls: 0 });
});

test('Model card updates retained description text safely without losing keyboard focus', () => {
	using card = services.createInstance(ModelCard, environment.window.document, undefined);
	card.update(entry);
	environment.window.document.body.append(card.domNode);
	card.focus();
	const description = card.domNode.firstChild;
	card.update({ ...entry, description: '<img src=x onerror=alert(1)> Updated model description' });
	assert.equal(card.domNode.firstChild, description);
	assert.equal(card.domNode.textContent?.trim(), '<img src=x onerror=alert(1)> Updated model description');
	assert.equal(card.domNode.querySelector('img'), null);
	assert.equal(environment.window.document.activeElement, card.domNode);
});

test('Model details hides missing descriptions and shows the next model without stale text', () => {
	const document = environment.window.document;
	const picker = document.createElement('div');
	const row = document.createElement('div');
	picker.append(row);
	document.body.append(picker);
	try {
		using details = services.createInstance(ModelPickerDetailsMenu, picker);
		details.show(entry, row);
		assert.equal(details.domNode.hidden, false);
		assert.equal(details.domNode.textContent?.trim(), entry.description);
		for (const description of [undefined, null, '', '   ']) {
			details.show({ ...entry, description }, row);
			assert.equal(details.domNode.hidden, true);
			assert.equal(details.domNode.textContent, '');
		}
		details.show({ ...entry, model: { provider: 'custom', model: 'other' }, displayName: 'Other model', description: 'Other description' }, row);
		details.focus();
		assert.equal(details.domNode.textContent?.trim(), 'Other description');
		assert.equal(document.activeElement?.getAttribute('aria-label'), 'Other model');
	} finally { picker.remove(); }
});


test('Configuration completion keeps a later keyboard target focused and reads checked state from its owner', async () => {
	const document = environment.window.document;
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	const writes: boolean[] = [];
	using card = services.createInstance(ModelCard, document, {
		getSelectedReasoningEffort: () => undefined,
		onReasoningEffortChange: async () => { },
		onAccelerationChange: async () => { },
		onLongContextChange: async value => { writes.push(value); await pending; },
	} satisfies IModelCardOptions);
	card.update(entry);
	const next = document.createElement('button');
	next.textContent = 'Next control';
	document.body.append(card.element, next);
	try {
		const expanded = card.element.querySelectorAll<HTMLInputElement>('input')[1]!;
		expanded.focus();
		expanded.click();
		assert.equal(expanded.disabled, true);
		next.focus();
		card.update({ ...entry, longContext: true });
		release();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ writes, checked: expanded.checked, disabled: expanded.disabled, focus: document.activeElement === next }, {
			writes: [true], checked: true, disabled: false, focus: true,
		});
	} finally { next.remove(); release(); }
});

test('Removing speed capability drops unavailable controls and returns keyboard focus to the card', () => {
	const document = environment.window.document;
	using card = services.createInstance(ModelCard, document, {
		getSelectedReasoningEffort: () => undefined,
		onReasoningEffortChange: async () => { },
		onAccelerationChange: async () => { },
		onLongContextChange: async () => { },
	} satisfies IModelCardOptions);
	card.update(entry);
	document.body.append(card.element);
	card.element.querySelector<HTMLInputElement>('input[aria-label="Fast"]')!.focus();
	card.update({ ...entry, accelerationOptions: [], selectedAcceleration: null });
	assert.deepEqual({
		groups: [...card.element.querySelectorAll('legend')].map(legend => legend.textContent),
		choices: card.element.querySelectorAll('input').length,
		focused: document.activeElement === card.element,
	}, { groups: ['Context Size'], choices: 2, focused: true });
});

test('Read-only model information shows fixed context without descriptions or configuration controls', () => {
	using card = services.createInstance(ModelCard, environment.window.document, undefined);
	card.update({ ...entry, description: null, contextWindow: 128_000, maximumContextWindow: 256_000, longContext: null });
	assert.deepEqual({ hidden: card.element.hidden, text: card.element.textContent, inputs: card.element.querySelectorAll('input').length }, {
		hidden: false, text: 'Max context: 256K', inputs: 0,
	});
	card.update({ ...entry, description: null });
	assert.equal(card.element.hidden, true);
});

test('Model card construction fails when its required opener is missing', () => {
	using missing = new InstantiationService();
	assert.throws(() => missing.createInstance(ModelCard, environment.window.document, undefined), /openerService/);
});
