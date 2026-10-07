import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ModelCard } from '../../browser/widget/input/modelPicker/modelPickerCard.js';
import { ModelPickerDetailsMenu } from '../../browser/widget/input/modelPicker/modelPickerHover.js';

const environment = new JSDOM('<!doctype html><body></body>');
suiteTeardown(() => environment.window.close());
const entry: ModelCatalogEntry = {
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	description: 'For demanding coding tasks.\nSupports images and tools.',
	longContext: false, accelerationOptions: [{ id: 'priority', name: 'Fast', description: 'Faster responses, increased usage' }],
};

for (const locale of ['en', 'zh-CN']) {
	test(`Model card displays the catalog description verbatim and exposes it to keyboard users in ${locale}`, () => {
		const catalog = builtinLanguagePackCatalogs.find(item => item.locale === locale)!;
		setNlsMessages(locale, catalog.bundles);
		try {
			using card = new ModelCard(environment.window.document);
			card.update(entry);
			environment.window.document.body.append(card.domNode);
			card.focus();
			assert.deepEqual({
				text: card.domNode.textContent, label: card.domNode.getAttribute('aria-label'),
				description: card.domNode.getAttribute('aria-description'), focused: environment.window.document.activeElement === card.domNode,
				controls: card.domNode.querySelectorAll('input, button').length,
			}, { text: entry.description, label: entry.displayName, description: entry.description, focused: true, controls: 0 });
		} finally { resetNlsResolver(); }
	});
}

test('Model card updates retained description text safely without losing keyboard focus', () => {
	using card = new ModelCard(environment.window.document);
	card.update(entry);
	environment.window.document.body.append(card.domNode);
	card.focus();
	const description = card.domNode.firstChild;
	card.update({ ...entry, description: '<img src=x onerror=alert(1)> Updated model description' });
	assert.equal(card.domNode.firstChild, description);
	assert.equal(card.domNode.textContent, '<img src=x onerror=alert(1)> Updated model description');
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
		using details = new ModelPickerDetailsMenu(picker);
		details.show(entry, row);
		assert.equal(details.domNode.hidden, false);
		assert.equal(details.domNode.textContent, entry.description);
		for (const description of [undefined, null, '', '   ']) {
			details.show({ ...entry, description }, row);
			assert.equal(details.domNode.hidden, true);
			assert.equal(details.domNode.textContent, '');
		}
		details.show({ ...entry, model: { provider: 'custom', model: 'other' }, displayName: 'Other model', description: 'Other description' }, row);
		details.focus();
		assert.equal(details.domNode.textContent, 'Other description');
		assert.equal(document.activeElement?.getAttribute('aria-label'), 'Other model');
	} finally { picker.remove(); }
});
