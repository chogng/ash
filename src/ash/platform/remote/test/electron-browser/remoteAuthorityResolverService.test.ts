import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { RemoteAuthorityResolverService } from '../../electron-browser/remoteAuthorityResolverService.js';
import { WebSocketRemoteConnection } from '../../common/remoteAuthorityResolver.js';
import { URI } from '../../../../base/common/uri.js';
import { DeferredPromise } from '../../../../base/common/async.js';

test('authority waiters share a published result and reconnect clears the old endpoint', async () => {
	using services = new InstantiationService();
	using resolver = services.createInstance(RemoteAuthorityResolverService);
	const first = resolver.resolveAuthority('team+build');
	const second = resolver.resolveAuthority('team+build');
	assert.equal(first, second);
	const authority = { authority: 'team+build', connectTo: new WebSocketRemoteConnection('localhost', 9999), connectionToken: 'secret' };
	resolver._setResolvedAuthority(authority);
	assert.deepEqual(await first, { authority });
	assert.deepEqual(resolver.getConnectionData('team+build'), { connectTo: authority.connectTo, connectionToken: authority.connectionToken });
	resolver._clearResolvedAuthority('team+build');
	assert.equal(resolver.getConnectionData('team+build'), null);
	const waiting = resolver.resolveAuthority('team+build');
	const failure = new Error('offline');
	resolver._setResolvedAuthorityError('team+build', failure);
	await assert.rejects(waiting, error => error === failure);
	await assert.rejects(resolver.resolveAuthority('team+build'), error => error === failure);
	resolver._clearResolvedAuthority('team+build');
	const pending = resolver.resolveAuthority('team+build');
	resolver.dispose();
	await assert.rejects(pending, /[Cc]ancel/);
});

test('canonical queries wait for a provider, share identity and discard results from retired resolutions', async () => {
	using resolver = new RemoteAuthorityResolverService();
	const uri = URI.parse('ash-remote://team+build/alias%2Fchild?q=1#fragment');
	const local = URI.file('/local');
	assert.equal(await resolver.getCanonicalURI(local), local);
	const waiting = resolver.getCanonicalURI(uri);
	assert.equal(resolver.getCanonicalURI(uri), waiting);
	let calls = 0;
	resolver._setCanonicalURIProvider(async resource => { calls++; return resource.with({ path: '/canonical' }); });
	assert.equal((await waiting).toString(), 'ash-remote://team+build/canonical?q=1#fragment');
	assert.equal(await resolver.getCanonicalURI(uri), await waiting);
	assert.equal(calls, 1);

	const late = new DeferredPromise<URI>();
	const entered = new DeferredPromise<void>();
	resolver._setCanonicalURIProvider(async () => { await entered.complete(); return late.p; });
	const old = resolver.getCanonicalURI(uri);
	await entered.p;
	const rejected = assert.rejects(old, /[Cc]ancel/);
	resolver._clearResolvedAuthority('team+build');
	await rejected;
	resolver._setCanonicalURIProvider(async resource => resource);
	await late.complete(uri.with({ path: '/stale' }));
	assert.equal(await resolver.getCanonicalURI(uri), uri);
	const pending = new DeferredPromise<URI>();
	resolver._setCanonicalURIProvider(() => pending.p);
	const disposed = assert.rejects(resolver.getCanonicalURI(uri), /[Cc]ancel/);
	resolver.dispose();
	await disposed;
	await pending.complete(uri);
});

test('resolver options are published with the endpoint and disappear on reconnect', async () => {
	using resolver = new RemoteAuthorityResolverService();
	const authority = { authority: 'team+build', connectTo: new WebSocketRemoteConnection('localhost', 9999), connectionToken: undefined };
	const options = { isTrusted: false, extensionHostEnv: { SET: 'value', REMOVE: null }, authenticationSession: { id: 'session', providerId: 'provider' } };
	const waiting = resolver.resolveAuthority(authority.authority);
	resolver._setResolvedAuthority(authority, options);
	assert.deepEqual(await waiting, { authority, options });
	resolver._clearResolvedAuthority(authority.authority);
	resolver._setResolvedAuthority(authority);
	assert.deepEqual(await resolver.resolveAuthority(authority.authority), { authority });
});
