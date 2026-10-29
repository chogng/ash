import assert from 'node:assert/strict';
import { test } from 'mocha';
import { getExtensionAttribution } from '../../common/extensionAttribution.js';

test('Extension attribution accepts declared authors without inferring authorship from publisher', () => {
	assert.equal(getExtensionAttribution({ author: '  Upstream team  ', publisher: 'adapter' }), 'Upstream team');
	assert.equal(
		getExtensionAttribution({ author: { name: 'Upstream team', url: 'https://example.invalid' } }),
		'Upstream team',
	);
	for (const manifest of [
		undefined,
		null,
		[],
		{ publisher: 'adapter' },
		{ author: '' },
		{ author: [] },
		{ author: { email: 'author@example.invalid' } },
		{ author: 42 },
		{ author: 'x'.repeat(513) },
	]) {
		assert.equal(getExtensionAttribution(manifest), '');
	}
});
