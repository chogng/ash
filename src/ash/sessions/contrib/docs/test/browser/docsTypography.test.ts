import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DocsFontFamily, readDocsTypography, writeDocsTypography } from '../../common/docsTypography.js';

test('typography metadata accepts only complete bounded document prefixes', () => {
	const value = { headings: DocsFontFamily.Serif, text: DocsFontFamily.Sans };
	for (const eol of ['\n', '\r\n']) {
		const block = writeDocsTypography(value).replace(/\n/gu, eol);
		assert.deepEqual(readDocsTypography(block + eol + eol + '# Title'), { value, end: block.length + eol.length });
	}
	for (const record of ['{}', '{"headings":"serif"}', '{"headings":"remote-font","text":"sans"}', '{"headings":"serif","text":"sans","extra":true}', '{"headings":"serif","text":"sans"', 'x'.repeat(600)]) {
		assert.equal(readDocsTypography('```ash-typography\n' + record + '\n```'), undefined);
	}
	assert.equal(readDocsTypography('# A code example\n\n' + writeDocsTypography(value)), undefined);
	const block = writeDocsTypography(value);
	assert.equal(readDocsTypography(block.replace('{', ' '.repeat(512 - block.length) + '{') + 'not a closing fence'), undefined);
});
