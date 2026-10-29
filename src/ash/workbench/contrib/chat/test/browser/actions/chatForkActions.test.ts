import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IAgentSessionService, IAgentThreadService } from '../../../../../../platform/agentHost/common/agentService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatService } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { registerChatActions } from '../../../browser/actions/chatActions.js';
import { ForkConversationAction, ForkConversationActionId } from '../../../browser/actions/chatForkActions.js';

registerChatActions();

function fixture(resources: DisposableStore) {
	const services = resources.add(new InstantiationService());
	services.registerInstance(IAccessibilityService, { status() {} } as unknown as IAccessibilityService);
	let active: { sessionId: string; threadId: string } | undefined = { sessionId: 'source', threadId: 'original' };
	let revision = 0;
	const opened: unknown[] = [];
	const requests: unknown[] = [];
	let finish = Promise.resolve();
	services.registerInstance(IChatSessionNavigationService, {
		get revision() {
			return revision;
		},
		getActiveConversation: () => active,
		openConversation: async (sessionId, threadId) => {
			opened.push({ sessionId, threadId });
		},
	} as IChatSessionNavigationService);
	services.registerInstance(IChatService, {
		readThread: async () => ({ thread: { title: 'Original' } }),
		rewriteRequest: async (options: Parameters<IChatService['rewriteRequest']>[0]) => {
			requests.push(options);
			await finish;
			return { sessionId: options.sessionId, threadId: 'rewritten' };
		},
	} as unknown as IChatService);
	services.registerInstance(IAgentThreadService, {
		fork: async options => {
			requests.push(options);
			await finish;
			return {
				sessionId: options.target === 'session' ? 'forked-session' : options.sessionId,
				threadId: 'forked-thread',
			};
		},
	} as IAgentThreadService);
	services.registerInstance(IAgentSessionService, {
		createThread: async options => {
			requests.push(options);
			await finish;
			return { session: { sessionId: options.sessionId }, threadId: 'new-peer' };
		},
	} as IAgentSessionService);
	return {
		services,
		opened,
		requests,
		run: (id: string, context?: unknown) =>
			Promise.resolve(services.invokeFunction(CommandsRegistry.getCommand(id)!, context)),
		select: (selection: typeof active) => {
			active = selection;
			revision++;
		},
		delay: (promise: Promise<void>) => {
			finish = promise;
		},
	};
}

for (const window of ['IDE', 'Agents'] as const) {
	test(`${window} Fork opens the correct destination without sending and coalesces repeated clicks`, async () => {
		using resources = new DisposableStore();
		resources.add(
			registerAction2(
				window === 'IDE'
					? ForkConversationAction
					: class extends ForkConversationAction {
							protected override readonly target = 'thread' as const;
						},
			),
		);
		const f = fixture(resources);
		const pending = new DeferredPromise<void>();
		f.delay(pending.p);
		const first = f.run(ForkConversationActionId);
		const second = f.run(ForkConversationActionId);
		await Promise.resolve();
		assert.equal(f.requests.length, 1);
		await pending.complete();
		await Promise.all([first, second]);
		assert.deepEqual(f.requests, [
			{
				sessionId: 'source',
				threadId: 'original',
				target: window === 'IDE' ? 'session' : 'thread',
				title: 'Forked: Original',
				commandId: (f.requests[0] as { commandId: string }).commandId,
			},
		]);
		assert.deepEqual(f.opened, [
			{ sessionId: window === 'IDE' ? 'forked-session' : 'source', threadId: 'forked-thread' },
		]);
	});
}

test('a title menu keeps its source and a late Fork cannot replace a newer selection', async () => {
	using resources = new DisposableStore();
	resources.add(registerAction2(ForkConversationAction));
	const f = fixture(resources);
	const pending = new DeferredPromise<void>();
	f.delay(pending.p);
	f.select({ sessionId: 'other', threadId: 'other-thread' });
	const run = f.run(ForkConversationActionId, { sessionId: 'source', threadId: 'original' });
	await pending.complete();
	await run;
	assert.equal((f.requests[0] as { sessionId: string }).sessionId, 'source');
	assert.deepEqual(f.opened, []);
});

test('new chat creates one empty peer in the same Session and leaves draft-only targets alone', async () => {
	using resources = new DisposableStore();
	const f = fixture(resources);
	const pending = new DeferredPromise<void>();
	f.delay(pending.p);
	const first = f.run('sessions.chatCompositeBar.addChat');
	const second = f.run('sessions.chatCompositeBar.addChat');
	assert.equal(f.requests.length, 1);
	await pending.complete();
	await Promise.all([first, second]);
	assert.deepEqual(f.opened, [{ sessionId: 'source', threadId: 'new-peer' }]);
	assert.equal((f.requests[0] as { sessionId: string }).sessionId, 'source');
	f.select(undefined);
	await f.run('sessions.chatCompositeBar.addChat');
	assert.equal(f.requests.length, 1);
});

test('edited request opens its result only while its original conversation is selected', async () => {
	using resources = new DisposableStore();
	const f = fixture(resources);
	const options = {
		sessionId: 'source',
		threadId: 'original',
		turnId: 'turn',
		itemId: 'backend-item',
		text: 'Edited\nrequest',
		commandId: 'edit-command',
	};
	await f.run('workbench.action.chat.resendRequest', options);
	assert.deepEqual(f.requests, [options]);
	assert.deepEqual(f.opened, [{ sessionId: 'source', threadId: 'rewritten' }]);
	const pending = new DeferredPromise<void>();
	f.delay(pending.p);
	const run = f.run('workbench.action.chat.resendRequest', options);
	f.select({ sessionId: 'other', threadId: 'other' });
	await pending.complete();
	await run;
	assert.equal(f.opened.length, 1);
	await assert.rejects(f.run('workbench.action.chat.resendRequest', { ...options, itemId: '' }), /accepted request/);
	assert.equal(f.requests.length, 2);
});

for (const id of [
	ForkConversationActionId,
	'sessions.chatCompositeBar.addChat',
	'workbench.action.chat.resendRequest',
]) {
	test(`${id} cannot open a late result after A-B-A navigation`, async () => {
		using resources = new DisposableStore();
		resources.add(registerAction2(ForkConversationAction));
		const f = fixture(resources);
		const pending = new DeferredPromise<void>();
		f.delay(pending.p);
		const context =
			id === 'workbench.action.chat.resendRequest'
				? {
						sessionId: 'source',
						threadId: 'original',
						turnId: 'turn',
						itemId: 'input',
						text: 'Edited',
						commandId: 'edit',
					}
				: undefined;
		const operation = f.run(id, context);
		f.select({ sessionId: 'other', threadId: 'other' });
		f.select({ sessionId: 'source', threadId: 'original' });
		await pending.complete();
		await operation;
		assert.equal(f.requests.length, 1);
		assert.deepEqual(f.opened, []);
	});
}
