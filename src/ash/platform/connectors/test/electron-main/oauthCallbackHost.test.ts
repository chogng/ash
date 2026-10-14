import assert from 'node:assert/strict';
import { test } from 'mocha';
import { request } from 'node:http';
import { OAuthCallbackHost } from '../../electron-main/oauthCallbackHost.js';

test('callback capacity includes concurrent listeners still opening', async () => {
	using host = new OAuthCallbackHost();
	const listen = host.routes().find(route => route.channel === 'ash:oauth-callback:listen')!;
	const results = await Promise.allSettled(Array.from({ length: 9 }, () => listen.invoke(undefined)));
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
	assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('closing a window cancels pending callback waits', async () => {
	const host = new OAuthCallbackHost();
	const routes = host.routes();
	const listen = routes.find(route => route.channel === 'ash:oauth-callback:listen')!;
	const result = await listen.invoke(undefined) as { id: string; };
	const wait = routes.find(route => route.channel === 'ash:oauth-callback:wait')!;
	const pending = wait.invoke(result.id);
	host.dispose();
	await assert.rejects(async () => pending, /closed/);
});

async function callbackRequest(redirectUri: string, path: string, method = 'GET'): Promise<number> {
	const endpoint = new URL(redirectUri);
	return new Promise((resolve, reject) => {
		const outgoing = request({ hostname: endpoint.hostname, port: endpoint.port, path, method }, response => {
			response.resume();
			response.on('end', () => resolve(response.statusCode!));
		});
		outgoing.on('error', reject);
		outgoing.end();
	});
}

test('standalone callback forwards issuer and ignores malformed paths and non-GET requests', async () => {
	using host = new OAuthCallbackHost();
	const routes = host.routes();
	const listen = routes.find(route => route.channel === 'ash:oauth-callback:listen')!;
	const wait = routes.find(route => route.channel === 'ash:oauth-callback:wait')!;
	const path = `/mcp-oauth/${'a'.repeat(64)}/callback`;
	assert.throws(() => listen.validate({ path: '/unbound' }));
	const result = await listen.invoke(listen.validate({ path })) as { id: string; redirectUri: string; };
	assert.equal(new URL(result.redirectUri).pathname, path);
	const pending = wait.invoke(result.id);
	assert.equal(await callbackRequest(result.redirectUri, 'http://['), 404);
	assert.equal(await callbackRequest(result.redirectUri, `${path}?state=s&code=c`, 'POST'), 404);
	assert.equal(await callbackRequest(result.redirectUri, `${path}?state=s&code=c&iss=https%3A%2F%2Fissuer.test`), 200);
	assert.deepEqual(await pending, { state: 's', code: 'c', issuer: 'https://issuer.test' });
});

test('standalone callback rejects duplicate issuers', async () => {
	using host = new OAuthCallbackHost();
	const routes = host.routes();
	const listen = routes.find(route => route.channel === 'ash:oauth-callback:listen')!;
	const wait = routes.find(route => route.channel === 'ash:oauth-callback:wait')!;
	const path = `/mcp-oauth/${'b'.repeat(64)}/callback`;
	const result = await listen.invoke(listen.validate({ path })) as { id: string; redirectUri: string; };
	const pending = wait.invoke(result.id);
	const rejected = assert.rejects(async () => pending, /valid callback/);
	assert.equal(await callbackRequest(result.redirectUri, `${path}?state=s&code=c&iss=one&iss=two`), 400);
	await rejected;
});
