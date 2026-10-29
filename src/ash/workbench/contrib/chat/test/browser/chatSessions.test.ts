import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import type { AgentSessionActivity } from '../../../../../platform/agentHost/common/agent.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { commitChatSession } from '../../browser/chatSessions/chatSessionCommit.js';
import { getInProgressSessionDescription } from '../../browser/chatSessions/chatSessionDescription.js';

test('Session descriptions use current activity and clear terminal-state operation text', () => {
	const activity = (status: AgentSessionActivity['status'], text?: string): AgentSessionActivity => ({
		status,
		statusChangedAtUnixMs: 0,
		activity: text === undefined ? undefined : { type: 'operation', text },
	});
	assert.equal(getInProgressSessionDescription(undefined), undefined);
	assert.equal(getInProgressSessionDescription(activity('working', '  Reading\n\tfiles  ')), 'Reading files');
	assert.equal(getInProgressSessionDescription(activity('needsInput', 'Approve the command')), 'Approve the command');
	for (const state of ['idle', 'readyForReview', 'completed', 'failed', 'stopped'] as const) {
		assert.equal(getInProgressSessionDescription(activity(state, 'Old operation')), undefined);
	}
	try {
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages('zh-CN', chinese.bundles);
		assert.equal(getInProgressSessionDescription(activity('working', ' \n ')), '进行中…');
		assert.equal(getInProgressSessionDescription(activity('needsInput')), '等待回应…');
	} finally {
		resetNlsResolver();
	}
});

test('A committed session adopts its composer before publication and retains it until subscription settles', async () => {
	const subscribed = new DeferredPromise<void>();
	const subscribing = new DeferredPromise<void>();
	let composer = 'draft';
	let published = '';
	let adoptionActive = false;
	const committed = commitChatSession({
		resolve: async () => 'durable',
		isCurrent: () => true,
		adopt: session => {
			composer = session;
			adoptionActive = true;
			return toDisposable(() => {
				adoptionActive = false;
			});
		},
		promote: session => {
			assert.equal(composer, session);
			published = session;
		},
		subscribe: async () => {
			await subscribing.complete();
			await subscribed.p;
		},
	});
	await subscribing.p;
	assert.equal(published, 'durable');
	assert.equal(adoptionActive, true);
	await subscribed.complete();
	assert.equal(await committed, 'durable');
	assert.equal(adoptionActive, false);
});

test('Late session creation publishes the durable identity without adopting or subscribing a retired composer', async () => {
	const created = new DeferredPromise<string>();
	let generation = 0;
	const captured = generation;
	const published: string[] = [];
	const committed = commitChatSession({
		resolve: () => created.p,
		isCurrent: () => generation === captured,
		adopt: () => {
			throw new Error('Retired composer adopted');
		},
		promote: session => {
			published.push(session);
		},
		subscribe: async () => {
			throw new Error('Retired composer subscribed');
		},
	});
	// Leaving and returning is a new lifetime even when the selected identity matches.
	generation += 2;
	await created.complete('durable');
	await assert.rejects(committed, isCancellationError);
	assert.deepEqual(published, ['durable']);
});

test('Navigation during catalog publication keeps the durable identity without subscribing the old composer', async () => {
	let current = true;
	let released = false;
	let published = false;
	await assert.rejects(
		commitChatSession({
			resolve: async () => 'durable',
			isCurrent: () => current,
			adopt: () =>
				toDisposable(() => {
					released = true;
				}),
			promote: () => {
				published = true;
				current = false;
			},
			subscribe: async () => {
				throw new Error('Retired composer subscribed');
			},
		}),
		isCancellationError,
	);
	assert.equal(published, true);
	assert.equal(released, true);
});

test('Navigation or failure during committed-session subscription releases adoption without completing an old send', async () => {
	for (const failure of [false, true]) {
		const subscribing = new DeferredPromise<void>();
		const subscribed = new DeferredPromise<void>();
		let current = true;
		let released = false;
		const committed = commitChatSession({
			resolve: async () => 'durable',
			isCurrent: () => current,
			adopt: () =>
				toDisposable(() => {
					released = true;
				}),
			promote: () => {},
			subscribe: async () => {
				await subscribing.complete();
				await subscribed.p;
			},
		});
		await subscribing.p;
		if (failure) await subscribed.error(new Error('Subscription failed'));
		else {
			current = false;
			await subscribed.complete();
		}
		await assert.rejects(committed, failure ? /Subscription failed/ : isCancellationError);
		assert.equal(released, true);
	}
});
