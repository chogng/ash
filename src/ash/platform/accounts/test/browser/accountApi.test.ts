import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createAppServerAccountApi, type BrowserAccountLoginHostServices } from '../../browser/accountApi.js';
import type { IAccountApi } from '../../common/accountApi.js';
import type { AppServerProtocolClient } from '../../../app-server/browser/appServerProtocolClient.js';
import type { AccountLoginStartResult } from '../../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerResponse } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';

function fixture(started: AccountLoginStartResult, rejectOpen = false): { api: IAccountApi; calls: unknown[]; } {
	const calls: unknown[] = [];
	const connection = {
		async request(definition: { method: string; }, params: unknown): Promise<AccountLoginStartResult | { status: string; }> {
			calls.push([definition.method, params]);
			return definition.method === 'account/login/start' ? started : { status: 'cancelled' };
		},
	} as unknown as AppServerProtocolClient;
	const hosts = {
		externalOpener: { async openExternal(url: string): Promise<boolean> { calls.push(['open', url]); if (rejectOpen) { throw new Error('browser unavailable'); } return true; } },
		clipboardService: { async writeText(text: string): Promise<void> { calls.push(['copy', text]); } },
	} as unknown as BrowserAccountLoginHostServices;
	return { api: createAppServerAccountApi(connection, hosts), calls };
}

test('reusing a Codex login does not open the browser or change the clipboard', async () => {
	const started: AccountLoginStartResult = { type: 'connected', loginId: 'login-1' };
	const response = { jsonrpc: '2.0', id: 1, result: started };
	assert.deepEqual(decodeAppServerResponse('account/login/start', response), response);
	assert.throws(() => decodeAppServerResponse('account/login/start', { ...response, result: { type: 'connected' } }));
	const { api, calls } = fixture(started);
	assert.deepEqual(await api.startLogin({ method: { type: 'openAiChatGptDeviceCode' } }), started);
	assert.deepEqual(calls, [['account/login/start', { method: { type: 'openAiChatGptDeviceCode' } }]]);
});

test('a first login opens the verification page and copies its device code', async () => {
	const started: AccountLoginStartResult = { type: 'deviceCode', loginId: 'login-2', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' };
	const { api, calls } = fixture(started);
	assert.deepEqual(await api.startLogin({ method: { type: 'openAiChatGptDeviceCode' } }), started);
	assert.deepEqual(calls.slice(1), [['open', started.verificationUrl], ['copy', started.userCode]]);
});

test('a failed browser handoff cancels that login without changing the clipboard', async () => {
	const started: AccountLoginStartResult = { type: 'deviceCode', loginId: 'login-3', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' };
	const { api, calls } = fixture(started, true);
	await assert.rejects(api.startLogin({ method: { type: 'openAiChatGptDeviceCode' } }), /browser unavailable/);
	assert.deepEqual(calls.slice(1), [['open', started.verificationUrl], ['account/login/cancel', { loginId: 'login-3' }]]);
});

for (const type of ['bigModelStartPlanBrowser', 'zaiStartPlanBrowser'] as const) {
	test(`${type} opens the official browser authorization and cancels a failed handoff`, async () => {
		const started: AccountLoginStartResult = { type: 'browser', loginId: 'start-plan-login', authorizationUrl: 'https://zcode.z.ai/authorize' };
		const method = { type };
		const success = fixture(started);
		assert.deepEqual(await success.api.startLogin({ method }), started);
		assert.deepEqual(success.calls, [['account/login/start', { method }], ['open', started.authorizationUrl]]);
		const failure = fixture(started, true);
		await assert.rejects(failure.api.startLogin({ method }), /browser unavailable/);
		assert.deepEqual(failure.calls, [['account/login/start', { method }], ['open', started.authorizationUrl], ['account/login/cancel', { loginId: started.loginId }]]);
	});
}
