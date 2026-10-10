import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// The test stops before token exchange; the reserved broker domain is never contacted.
test.use({ githubAccount: { clientId: 'AshSmokeGitHub', brokerBaseUrl: 'https://github-broker.example/' } });

test('GitHub Rust extension shares a profile across directories and releases a disconnected login owner', async ({ workbench, target, application, webAppServer, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the real profile App Server.');
	const otherDirectory = join(testWorkspace.directory, 'other-github-window');
	await mkdir(otherDirectory);
	const source = webAppServer ? await workbench.page.context().newPage() : workbench.page;
	if (webAppServer) {
		await source.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
	}
	let first: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let second: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let pending: string | undefined;
	try {
		first = await connectProfile(application, webAppServer, testWorkspace.directory, source);
		// The browser transport is rooted in its workspace; the second trusted host
		// exercises another directory of the same profile through the product daemon.
		second = await connectProfile(application, webAppServer, otherDirectory, workbench.page, { directoryPermissionsHost: !!webAppServer });
		const started = await first.client.request(APP_SERVER_METHODS['account/login/start'], { method: { type: 'gitHubBrowser' } });
		expect(started.type).toBe('browser');
		if (started.type !== 'browser') { throw new Error('Expected the GitHub browser grant'); }
		const authorization = new URL(started.authorizationUrl);
		expect(authorization.origin).toBe('https://github-broker.example');
		expect(authorization.pathname).toBe('/v1/oauth/github/authorize');
		expect(authorization.searchParams.get('client_id')).toBe('AshSmokeGitHub');
		await expect(second.client.request(APP_SERVER_METHODS['account/login/start'], { method: { type: 'gitHubBrowser' } })).rejects.toMatchObject({ errorName: 'AccountLoginConflict' });
		expect(await second.client.request(APP_SERVER_METHODS['account/login/cancel'], { loginId: started.loginId })).toEqual({ status: 'notFound' });
		await first.close();
		first = undefined;
		// Observe actual disconnect cleanup, without assuming transport-close timing.
		await expect.poll(async () => {
			try {
				const next = await second!.client.request(APP_SERVER_METHODS['account/login/start'], { method: { type: 'gitHubBrowser' } });
				pending = next.loginId;
				return next.type;
			} catch (error) {
				if ((error as { errorName?: string }).errorName === 'AccountLoginConflict') { return 'waitingForDisconnect'; }
				throw error;
			}
		}).toBe('browser');
		expect(await second.client.request(APP_SERVER_METHODS['account/login/cancel'], { loginId: pending! })).toEqual({ status: 'cancelled' });
		pending = undefined;
		const account = await second.client.request(APP_SERVER_METHODS['account/read'], {});
		expect(account.accounts.filter(entry => entry.provider === 'github')).toEqual([]);
	} finally {
		if (pending && second) { await second.client.request(APP_SERVER_METHODS['account/login/cancel'], { loginId: pending }).catch(() => undefined); }
		await first?.close();
		await second?.close();
		if (webAppServer) { await source.close(); }
	}
});
