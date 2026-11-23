import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { getImageResourceMime, isGitLfsPointer } from '../../common/mediaPreview.js';

test('image preview matches supported formats and gives explicit MIME types precedence', () => {
	for (const [extension, mime] of [
		['PNG', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['bmp', 'image/bmp'],
		['webp', 'image/webp'], ['avif', 'image/avif'], ['svg', 'image/svg+xml'], ['ico', 'image/x-icon'],
	] as const) {
		assert.equal(getImageResourceMime({ resource: URI.file(`/images/picture.${extension}`) }), mime);
	}
	const unknown = URI.file('/images/picture.unknown');
	assert.equal(getImageResourceMime({ resource: unknown }), undefined);
	assert.equal(getImageResourceMime({ resource: unknown, contentType: 'image/vnd.microsoft.icon' }), 'image/x-icon');
	assert.equal(getImageResourceMime({ resource: URI.file('/images/picture.jpg'), contentType: 'image/png; example=1' }), 'image/png');
	assert.equal(getImageResourceMime({ resource: URI.file('/images/picture.png'), contentType: 'image/tiff' }), undefined);
});

test('Git LFS detection only accepts small pointers from Git revisions', () => {
	const pointer = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\r\noid sha256:abc\nsize 123\n');
	assert.equal(isGitLfsPointer(URI.parse('git:/image.png'), pointer), true);
	assert.equal(isGitLfsPointer(URI.file('/image.png'), pointer), false);
	assert.equal(isGitLfsPointer(URI.parse('git:/image.png'), new Uint8Array([...pointer, ...new Uint8Array(1024)])), false);
	assert.equal(isGitLfsPointer(URI.parse('git:/image.png'), new TextEncoder().encode('version https://example.com/spec/v1\n')), false);
});
