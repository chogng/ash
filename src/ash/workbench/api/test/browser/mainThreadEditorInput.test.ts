import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseExtensionEditorInput } from '../../browser/mainThreadEditorInput.js';
import { isMultiDiffEditorInput } from '../../../contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { isBinaryDiffEditorInput } from '../../../common/editor/diffEditorInput.js';

test('extension binary comparisons select the byte editor for immutable versions', () => {
	const input = parseExtensionEditorInput({ kind: 'binaryDiff', label: 'Byte comparison', original: { resource: 'snapshot:/before', initialBytes: [0, 255] }, modified: { resource: 'snapshot:/after', initialBytes: [0, 254] } });
	assert.ok(isBinaryDiffEditorInput(input));
	assert.deepEqual(input.original.initialBytes, Uint8Array.from([0, 255]));
	assert.deepEqual(input.modified.initialBytes, Uint8Array.from([0, 254]));
	assert.equal(input.original.readOnly, true);
	input.dispose();
});

test('extension comparisons retain binary versions without filesystem providers', () => {
	const originalBytes = [0, 255, 1];
	const input = parseExtensionEditorInput({
		kind: 'multiDiff', resource: 'comparison:/binary', label: 'Binary versions', items: [{
			label: 'image.bin', binary: true,
			original: { resource: 'snapshot:/before', contentType: 'application/octet-stream', initialBytes: originalBytes },
			modified: { resource: 'snapshot:/after', contentType: 'application/octet-stream', initialBytes: [0, 254, 2] },
		}],
	});
	assert.ok(isMultiDiffEditorInput(input));
	assert.equal(input.items[0].binary, true);
	assert.equal(input.readOnly, true);
	assert.equal(input.items[0].original.contentType, 'application/octet-stream');
	assert.deepEqual(input.items[0].original.initialBytes, Uint8Array.from([0, 255, 1]));
	assert.deepEqual(input.items[0].modified.initialBytes, Uint8Array.from([0, 254, 2]));
	assert.equal(input.items[0].original.readOnly, true);
	originalBytes[1] = 0;
	assert.deepEqual(input.items[0].original.initialBytes, Uint8Array.from([0, 255, 1]));
});

test('extension editor inputs reject invalid binary data at the bridge boundary', () => {
	for (const initialBytes of [[-1], [256], [0.5], ['0'], null]) {
		assert.throws(() => parseExtensionEditorInput({ resource: 'snapshot:/invalid', initialBytes }), /Invalid extension editor bytes/);
	}
	assert.throws(() => parseExtensionEditorInput({ kind: 'multiDiff', resource: 'comparison:/invalid', label: 'Invalid', items: [{ label: 'image.bin', binary: 'true', original: { resource: 'snapshot:/before' }, modified: { resource: 'snapshot:/after' } }] }), /Invalid multi-diff binary state/);
});

test('extension editor inputs retain validated snapshot encodings', () => {
	const input = parseExtensionEditorInput({ resource: 'snapshot:/bom', initialText: '\uFEFFcontent', encoding: 'utf8bom' });
	assert.equal(input.encoding, 'utf8bom');
	assert.equal(input.initialText, '\uFEFFcontent');
	assert.equal(input.readOnly, true);
	for (const encoding of ['invalid', 1, false, {}]) {
		assert.throws(() => parseExtensionEditorInput({ resource: 'snapshot:/invalid', encoding }));
	}
});

test('extension snapshots preserve preferred file identity and language independently of content identity', () => {
	const input = parseExtensionEditorInput({ resource: 'git-change:/unstaged/TODO.md', preferredResource: 'file:///project/TODO.md', languageId: 'markdown', initialText: '# Heading' });
	assert.equal(input.resource.toString(), 'git-change:/unstaged/TODO.md');
	assert.equal(input.preferredResource?.toString(), 'file:///project/TODO.md');
	assert.equal(input.languageId, 'markdown');
});
