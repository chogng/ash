import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { isGitLfsPointer } from '../../common/mediaPreview.js';

test('Git LFS detection only accepts small pointers from Git revisions', () => {
	const pointer = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\r\noid sha256:abc\nsize 123\n');
	assert.equal(isGitLfsPointer(URI.parse('git:/image.png'), pointer), true);
	assert.equal(isGitLfsPointer(URI.file('/image.png'), pointer), false);
	assert.equal(isGitLfsPointer(URI.parse('git:/image.png'), new Uint8Array([...pointer, ...new Uint8Array(1024)])), false);
	assert.equal(isGitLfsPointer(URI.parse('git:/image.png'), new TextEncoder().encode('version https://example.com/spec/v1\n')), false);
});
