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

test('icon-aware matches retain UTF-16 offsets and the existing optional argument', () => {
	const parsed = parseLabelWithIcons('$(add) 🌲 File');
	assert.deepEqual(matchesFuzzyIconAware('🌲f', parsed), [
		{ start: 7, end: 9 },
		{ start: 10, end: 11 },
	]);
	assert.deepEqual(matchesFuzzyIconAware('🌲f', parsed, true), [
		{ start: 7, end: 9 },
		{ start: 10, end: 11 },
	]);
});

test('icon-aware matches map lowercase expansions back to the original label', () => {
	const parsed = parseLabelWithIcons('$(add) İb');
	assert.deepEqual(matchesFuzzyIconAware('b', parsed), [{ start: 8, end: 9 }]);
	assert.deepEqual(matchesFuzzyIconAware('ib', parsed), [{ start: 7, end: 9 }]);
});
