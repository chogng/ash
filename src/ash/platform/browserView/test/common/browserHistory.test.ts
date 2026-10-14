import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { BrowserHistoryStore } from '../../common/browserHistory.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('Browser visit history', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('bounded history keeps newer visits and stale handles cannot retain images or mutate replacements', () => {
		using history = new BrowserHistoryStore(2);
		const first = history.add('https://example.test/one', 'One', 'data:image/png;base64,one', true);
		const second = history.add('https://example.test/two', 'Two');
		const third = history.add('https://example.test/three', 'Three');
		first.update({ favicon: 'data:image/png;base64,stale', title: 'Stale' });
		first.delete();
		second.update({ title: 'Updated', favicon: 'data:image/png;base64,two' });
		assert.deepEqual(history.entries.items.map(entry => [entry.id, entry.title]), [[second.id, 'Updated'], [third.id, 'Three']]);
		assert.deepEqual(Object.values(history.favicons.serialize().map), ['data:image/png;base64,two']);
		history.clear();
		assert.deepEqual([history.entries.items, history.favicons.serialize().map], [[], {}]);
	});

	test('disabled stores retain neither visits nor inline images', () => {
		using history = new BrowserHistoryStore(0);
		const handle = history.add('https://example.test/private', 'Private', 'data:image/png;base64,private');
		assert.equal(handle.id, -1);
		handle.update({ title: 'Changed', favicon: 'data:image/png;base64,changed' });
		assert.deepEqual([history.entries.items, history.favicons.serialize().map], [[], {}]);
	});
});
