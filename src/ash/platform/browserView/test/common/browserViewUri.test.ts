import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { BrowserViewUri } from '../../common/browserViewUri.js';

test('browser resources preserve page identity and recognize only the browser scheme', () => {
	const resource = BrowserViewUri.forId('browser_target_123');
	assert.deepEqual(BrowserViewUri.parse(URI.parse(resource.toString())), { id: 'browser_target_123' });
	assert.equal(BrowserViewUri.getId(URI.parse('https://example.test/browser_target_123')), undefined);
	assert.equal(BrowserViewUri.parse(URI.from({ scheme: BrowserViewUri.scheme, path: '/' })), undefined);
});
