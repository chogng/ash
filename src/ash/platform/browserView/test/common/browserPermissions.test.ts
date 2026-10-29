import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { BrowserPermissionStore, PermissionCategory, electronPermissionToCategories, toOriginKey } from '../../common/browserPermissions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('Browser site permission decisions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('camera and microphone remain independent and malformed or opaque sites have no decision identity', () => {
		using store = new BrowserPermissionStore();
		for (const category of electronPermissionToCategories('media', ['video'])) {
			store.set('https://example.test/path', category, 'allow');
		}
		assert.equal(store.getDecision('https://example.test:443/other', PermissionCategory.Camera), 'allow');
		assert.equal(store.getDecision('https://example.test/', PermissionCategory.Microphone), undefined);
		assert.deepEqual(['null', 'about:blank', 'not a url', undefined].map(toOriginKey), ['', '', '', '']);
		store.set('about:blank', PermissionCategory.Camera, 'allow');
		assert.equal(store.getDecision('about:blank', PermissionCategory.Camera), undefined);
		store.set('https://example.test', PermissionCategory.Camera, null);
		assert.equal(store.getDecision('https://example.test', PermissionCategory.Camera), undefined);
	});
});
