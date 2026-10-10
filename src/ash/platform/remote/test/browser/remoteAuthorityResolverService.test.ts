import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { RemoteAuthorityResolverService } from '../../browser/remoteAuthorityResolverService.js';
import { WebSocketRemoteConnection } from '../../common/remoteAuthorityResolver.js';

test('Web preserves URI identity and consumes only addresses published by its host', async () => {
	using resolver = new RemoteAuthorityResolverService();
	const uri = URI.parse('ash-remote://team+build/root%2Ffile?q=1#fragment');
	assert.equal(await resolver.getCanonicalURI(uri), uri);
	await assert.rejects(resolver.resolveAuthority(uri.authority), { _code: 'NoResolverFound' });
	const authority = { authority: uri.authority, connectTo: new WebSocketRemoteConnection('localhost', 5000), connectionToken: undefined };
	const options = { isTrusted: false };
	resolver._setResolvedAuthority(authority, options);
	assert.deepEqual(await resolver.resolveAuthority(uri.authority), { authority, options });
	resolver._clearResolvedAuthority(uri.authority);
	assert.equal(resolver.getConnectionData(uri.authority), null);
});
