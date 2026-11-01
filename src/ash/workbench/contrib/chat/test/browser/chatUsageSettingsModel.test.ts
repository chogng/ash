import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IChatService, type ChatContextUsage, type Thread } from '../../../../services/chat/common/chatService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { IChatWidgetService, type IChatWidget } from '../../browser/chat.js';
import { ChatUsageSettingsModel } from '../../browser/chatUsageSettingsModel.js';

const context: ChatContextUsage = {
	estimatedTokens: 200, contextWindow: 1000, autoCompactAt: 800,
	model: { provider: 'test', model: 'fixture' },
	categories: [{ category: 'systemPrompt', tokens: 200 }],
};

function thread(threadId: string): Thread {
	const complete = { reported: 0, complete: true };
	return {
		advisor: { type: 'default' }, agentId: 'agent', origin: { type: 'root' },
		sessionId: 'session', threadId, title: threadId, status: 'active', sequence: 1, turns: [],
		usage: {
			modelInvocations: 2, inputTokens: { reported: 1200, complete: true }, outputTokens: { reported: 90, complete: false },
			cachedInputTokens: { reported: 0, complete: false }, cacheWriteInputTokens: complete, reasoningTokens: complete,
		},
	};
}

function fixture(readContextUsage: IChatService['readContextUsage'] = async () => context) {
	const services = new InstantiationService();
	const changed = new Emitter<void>();
	let selected: IChatWidget | undefined;
	const reads: unknown[][] = [];
	services.registerInstance(IChatService, {
		onDidBecomeReady: Event.None, onDidUpdateThread: Event.None,
		readContextUsage,
		readThread: async (...args: Parameters<IChatService['readThread']>) => {
			reads.push(args);
			return { thread: thread(args[1]) };
		},
	} as unknown as IChatService);
	services.registerInstance(IChatWidgetService, {
		onDidChangeWidgets: changed.event,
		get lastFocusedWidget() { return selected; },
		getAllWidgets: () => selected ? [selected] : [],
		register: () => { throw new Error('Not used by this fixture'); },
	});
	const model = services.createInstance(ChatUsageSettingsModel);
	return {
		model, reads,
		select(threadId: string | undefined): void {
			selected = threadId ? { visible: true, sessionId: 'session', threadId } as IChatWidget : undefined;
			changed.fire();
		},
		[Symbol.dispose](): void { model.dispose(); changed.dispose(); services.dispose(); },
	};
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const text = (model: ChatUsageSettingsModel): string => model.fields.filter(field => field.kind === 'status').map(field => field.text).join('\n');

for (const locale of ['en', 'zh-CN']) {
	test(`Usage separates context estimates from bounded chat totals (${locale})`, async () => {
		initializeTestLocalization(locale);
		try {
			using state = fixture();
			state.select('first');
			state.model.setVisible(true);
			await settle();
			const content = text(state.model);
			assert.match(content, /200/u);
			assert.match(content, /25%/u);
			assert.match(content, /1,200/u);
			assert.match(content, locale === 'en' ? /At least 90/u : /至少 90/u);
			assert.match(content, locale === 'en' ? /Cached input tokens: Unavailable/u : /缓存输入 token：暂无数据/u);
			assert.match(content, /test\/fixture/u);
			assert.match(content, locale === 'en' ? /Model context capacity: 1,000/u : /模型上下文容量：1,000/u);
			assert.deepEqual(state.reads, [['session', 'first', { type: 'latest', turnLimit: 1 }]]);
		} finally { initializeTestLocalization('en'); }
	});
}

test('Usage does not read without a chat, and refreshes through the existing action contract', async () => {
	using state = fixture();
	state.model.setVisible(true);
	assert.match(text(state.model), /Open a chat/u);
	assert.equal(state.reads.length, 0);
	state.select('first');
	await settle();
	const refresh = state.model.fields.find(field => field.kind === 'action');
	assert.ok(refresh?.kind === 'action');
	assert.equal(refresh.enabled, true);
	await refresh.run();
	assert.equal(state.reads.length, 2);
});

test('Usage discards a previous chat’s late result and any result after Settings hides', async () => {
	const first = new DeferredPromise<ChatContextUsage>();
	const second = new DeferredPromise<ChatContextUsage>();
	using state = fixture(async (_sessionId, threadId) => threadId === 'first' ? first.p : second.p);
	state.select('first');
	state.model.setVisible(true);
	state.select('second');
	await second.complete({ ...context, estimatedTokens: 400 });
	await settle();
	assert.match(text(state.model), /400/u);
	await first.complete({ ...context, estimatedTokens: 999 });
	await settle();
	assert.doesNotMatch(text(state.model), /999/u);
	state.select('first');
	state.model.setVisible(false);
	const hidden = text(state.model);
	await settle();
	assert.equal(text(state.model), hidden);
});

test('Usage retains the last snapshot on refresh failure and offers retry', async () => {
	let fail = false;
	using state = fixture(async () => {
		if (fail) { throw new Error('fixture disconnected'); }
		return context;
	});
	state.select('first');
	state.model.setVisible(true);
	await settle();
	fail = true;
	const refresh = state.model.fields.find(field => field.kind === 'action');
	assert.ok(refresh?.kind === 'action');
	await refresh.run();
	assert.match(text(state.model), /Could not load usage/u);
	assert.match(text(state.model), /Estimated context: 200/u);
	fail = false;
	await refresh.run();
	assert.doesNotMatch(text(state.model), /Could not load usage/u);
});
