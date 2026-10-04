import { URI } from '../../../../base/common/uri.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { normalizeExternalUrl, withSelection, extractSelection } from '../../common/opener.js';

test('normalizeExternalUrl accepts HTTP(S) and mailto URLs', () => {
	assert.equal(normalizeExternalUrl('https://example.test/oauth?state=1'), 'https://example.test/oauth?state=1');
	assert.equal(normalizeExternalUrl('http://127.0.0.1:3000/callback'), 'http://127.0.0.1:3000/callback');
	assert.equal(normalizeExternalUrl('mailto:help@example.test'), 'mailto:help@example.test');
});

test('normalizeExternalUrl rejects local and executable schemes', () => {
	assert.throws(() => normalizeExternalUrl('/relative'), /absolute/u);
	assert.throws(() => normalizeExternalUrl('file:///tmp/secret'), /not allowed/u);
	assert.throws(() => normalizeExternalUrl('javascript:alert(1)'), /not allowed/u);
	assert.throws(() => normalizeExternalUrl('mailto:'), /recipient/u);
	assert.throws(() => normalizeExternalUrl('https://example.test\r\nBcc: attacker@example.test'), /line break/u);
});

test('selection URIs preserve resource identity when extracting positions and ranges', () => {
	const uri = URI.file('/workspace/file.ts');
	const selection = { startLineNumber: 12, startColumn: 7, endLineNumber: 15, endColumn: 3 };
	const extracted = extractSelection(withSelection(uri, selection));
	assert.equal(extracted.uri.toString(), uri.toString());
	assert.deepEqual(extracted.selection, selection);
	assert.deepEqual(extractSelection(uri.with({ fragment: 'L12,7' })).selection, { startLineNumber: 12, startColumn: 7, endLineNumber: undefined, endColumn: undefined });
	const anchor = uri.with({ fragment: 'section' });
	assert.equal(extractSelection(anchor).uri, anchor);
});
