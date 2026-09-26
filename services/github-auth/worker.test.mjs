import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.ts';

const origin = 'https://ash-github-auth.example.workers.dev';
const environment = {
	GITHUB_CLIENT_ID: 'Iv23publicclient',
	GITHUB_CLIENT_SECRET: 'test-secret',
	STATE_SIGNING_SECRET: 'test-state-signing-secret',
};
const redirectUri = `http://127.0.0.1:58123/github-oauth/${'A'.repeat(43)}`;
const clientState = 'B'.repeat(43);
const challenge = 'C'.repeat(43);

function authorizationRequest(overrides = {}) {
	const url = new URL('/v1/oauth/github/authorize', origin);
	for (const [key, value] of Object.entries({
		client_id: environment.GITHUB_CLIENT_ID,
		redirect_uri: redirectUri,
		state: clientState,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		...overrides,
	})) url.searchParams.set(key, value);
	return new Request(url);
}

test('authorization signs callback state and forwards only the code to the local listener', async () => {
	const authorization = await worker.fetch(authorizationRequest(), environment);
	assert.equal(authorization.status, 302);
	const github = new URL(authorization.headers.get('Location'));
	assert.equal(github.origin, 'https://github.com');
	assert.equal(github.searchParams.get('code_challenge'), challenge);
	assert.equal(github.searchParams.get('redirect_uri'), `${origin}/v1/oauth/github/callback`);
	const callback = new URL(github.searchParams.get('redirect_uri'));
	callback.searchParams.set('state', github.searchParams.get('state'));
	callback.searchParams.set('code', 'private-code');
	const result = await worker.fetch(new Request(callback), environment);
	assert.equal(result.status, 302);
	const local = new URL(result.headers.get('Location'));
	assert.equal(`${local.origin}${local.pathname}`, redirectUri);
	assert.equal(local.searchParams.get('state'), clientState);
	assert.equal(local.searchParams.get('code'), 'private-code');
	assert.equal(result.headers.get('Cache-Control'), 'no-store');
	callback.searchParams.set('state', `${github.searchParams.get('state')}tampered`);
	assert.equal((await worker.fetch(new Request(callback), environment)).status, 400);
	callback.searchParams.set('state', github.searchParams.get('state'));
	callback.searchParams.delete('code');
	callback.searchParams.set('error', 'access_denied');
	const declined = await worker.fetch(new Request(callback), environment);
	assert.equal(new URL(declined.headers.get('Location')).searchParams.get('error'), 'access_denied');
	const originalNow = Date.now;
	try {
		Date.now = () => originalNow() + 601_000;
		assert.equal((await worker.fetch(new Request(callback), environment)).status, 400);
	} finally {
		Date.now = originalNow;
	}
});

test('authorization rejects unsafe or repeated callback parameters', async () => {
	for (const unsafe of ['https://example.com/steal', 'http://localhost:58123/github-oauth/' + 'A'.repeat(43), 'http://127.0.0.1:58123/other']) {
		assert.equal((await worker.fetch(authorizationRequest({ redirect_uri: unsafe }), environment)).status, 400);
	}
	const repeated = new URL(authorizationRequest().url);
	repeated.searchParams.append('state', 'another');
	assert.equal((await worker.fetch(new Request(repeated), environment)).status, 400);
});

test('token exchange keeps the client secret on the server and returns refresh errors', async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, body: String(init.body) });
		return new Response(JSON.stringify(calls.length === 1
			? { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 28800, token_type: 'bearer' }
			: { error: 'bad_refresh_token' }), { headers: { 'Content-Type': 'application/json' } });
	};
	try {
		const form = new URLSearchParams({ client_id: environment.GITHUB_CLIENT_ID, grant_type: 'authorization_code', code: 'private-code', code_verifier: 'D'.repeat(43), redirect_uri: redirectUri });
		const request = new Request(`${origin}/v1/oauth/github/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
		const token = await worker.fetch(request, environment);
		assert.deepEqual(await token.json(), { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 28800, token_type: 'bearer' });
		assert.equal(calls.length, 1);
		assert.equal(new URLSearchParams(calls[0].body).get('client_secret'), environment.GITHUB_CLIENT_SECRET);
		assert.equal(new URLSearchParams(calls[0].body).get('redirect_uri'), `${origin}/v1/oauth/github/callback`);
		const refresh = new URLSearchParams({ client_id: environment.GITHUB_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'private-refresh' });
		const response = await worker.fetch(new Request(`${origin}/v1/oauth/github/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: refresh }), environment);
		assert.deepEqual(await response.json(), { error: 'bad_refresh_token' });
	} finally {
		globalThis.fetch = originalFetch;
	}
});
