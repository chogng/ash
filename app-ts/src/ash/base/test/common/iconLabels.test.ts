import assert from 'node:assert/strict';
import { test } from 'mocha';
import { escapeIcons, getIconAriaLabel, matchesFuzzyIconAware, parseLabelWithIcons, stripIcons } from '../../common/iconLabels.js';

test('icon labels escape, strip, and describe literal icon syntax', () => {
	assert.equal(escapeIcons('$(add) File'), '\\$(add) File');
	assert.equal(escapeIcons('\\$(add)'), '\\$(add)');
	assert.equal(stripIcons('$(add) File'), ' File');
	assert.equal(stripIcons('\\$(add) File'), '\\$(add) File');
	assert.equal(getIconAriaLabel('$(add) Add file'), 'add  Add file');
	assert.equal(parseLabelWithIcons('$(Action~Spin) File').text, ' File');
});

test('icon-aware parsing maps fuzzy matches to source offsets', () => {
	const parsed = parseLabelWithIcons('$(add) File');
	assert.equal(parsed.text, ' File');
	assert.deepEqual(matchesFuzzyIconAware('fi', parsed), [{ start: 7, end: 9 }]);
	assert.deepEqual(matchesFuzzyIconAware('zz', parsed), null);
});
