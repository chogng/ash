import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import type { IAccountApi } from '../../../../../platform/accounts/common/accountApi.js';
import { AppServerAccountService } from '../../browser/appServerAccountService.js';

test('Account limits preserve absent fields and identity through the domain adapter', async () => {
	const signal = new AbortController().signal;
	const expected = {
		provider: 'chatgpt-subscription', accountId: 'one', plan: null,
		limits: [{ id: 'codex', name: null, model: null, allowed: null, limitReached: null, primary: null, secondary: null }],
		credits: { hasCredits: true, unlimited: false, balance: null },
	};
	using service = new AppServerAccountService({
		readRateLimits: async (params, receivedSignal) => {
			assert.deepEqual(params, { provider: expected.provider, accountId: expected.accountId });
			assert.equal(receivedSignal, signal);
			return expected;
		},
	} as IAccountApi, { subscribe: Event.None });
	const result = await service.readRateLimits(expected.provider, expected.accountId, signal);
	assert.deepEqual(result, { ...expected, xai: null });
	assert.notEqual(result.limits[0], expected.limits[0]);
	assert.notEqual(result.credits, expected.credits);
});

test('Account limits reject a reply for another account or provider', async () => {
	for (const identity of [{ provider: 'other', accountId: 'one' }, { provider: 'chatgpt-subscription', accountId: 'two' }]) {
		using service = new AppServerAccountService({
			readRateLimits: async () => ({ ...identity, plan: null, limits: [], credits: null }),
		} as unknown as IAccountApi, { subscribe: Event.None });
		await assert.rejects(service.readRateLimits('chatgpt-subscription', 'one'), /does not match/);
	}
});
