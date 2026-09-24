import assert from 'node:assert/strict';
import { test } from 'mocha';
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
	const result = await listen.invoke(undefined) as { id: string };
	const wait = routes.find(route => route.channel === 'ash:oauth-callback:wait')!;
	const pending = wait.invoke(result.id);
	host.dispose();
	await assert.rejects(async () => pending, /closed/);
});
