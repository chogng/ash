import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { filterQuickPickItems } from '../../browser/quickInputList.js';
import type { IQuickPickItem } from '../../common/quickInput.js';

suite('Quick Input list filtering', () => {
	test('uses the strongest fuzzy alignment while retaining stable ties', () => {
		const first = { label: 'a--xb' };
		const strongest = { label: 'a---ab' };
		const tied = { label: 'a---ab' };
		assert.deepEqual(filterQuickPickItems([first, strongest, tied], 'ab'), [strongest, tied, first]);
	});

	test('requires every token, preferring labels while accepting description and detail matches', () => {
		const description = { label: 'Open', description: 'Server' };
		const label = { label: 'Open Server' };
		const detail = { label: 'Open', detail: 'Server' };
		const unrelated = { label: 'Open Client' };
		assert.deepEqual(filterQuickPickItems([description, label, detail, unrelated], ' OPEN  server '), [
			label,
			description,
			detail,
		]);
	});

	test('keeps always-show items and unfiltered input order', () => {
		const items: IQuickPickItem[] = [{ label: 'Second' }, { label: 'First', alwaysShow: true }];
		assert.deepEqual(filterQuickPickItems(items, '   '), items);
		assert.deepEqual(filterQuickPickItems(items, 'missing'), [items[1]]);
	});

	test('handles astral text and lowercase expansion through the production filter', () => {
		const item = { label: 'İstanbul 😀 files' };
		assert.deepEqual(filterQuickPickItems([item, { label: 'Other' }], 'i😀'), [item]);
	});
});
