import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensionService.js';
import { ChatContextPickService, IChatContextPickService, isChatContextPickerPickItem } from '../../../browser/attachments/chatContextPickService.js';
import { ChatContextContribution } from '../../../browser/contextContrib/chatContext.contribution.js';
import { IChatContextService, ChatContextService } from '../../../browser/contextContrib/chatContextService.js';
import type { IChatContextItem } from '../../../common/contextContrib/chatContext.js';

function setup(activate?: () => void) {
	const lifetime = new DisposableStore();
	const instantiation = lifetime.add(new InstantiationService());
	const picks = new ChatContextPickService();
	const activations: string[] = [];
	instantiation.registerInstance(IChatContextPickService, picks);
	instantiation.registerInstance(IExtensionService, {
		activateByEvent: async (event: string) => { activations.push(event); activate?.(); },
	} as IExtensionService);
	const service = lifetime.add(instantiation.createInstance(ChatContextService));
	return { service, picks, activations, lifetime, [Symbol.dispose]: () => lifetime.dispose() };
}

suite('Chat context providers', () => {
	test('production DI assembly rejects a missing required registration', () => {
		using instantiation = new InstantiationService();
		assert.throws(() => instantiation.createInstance(ChatContextService));
	});

	test('committed extension declarations publish and withdraw lazy sources in the production contribution', () => {
		using lifetime = new DisposableStore();
		const instantiation = lifetime.add(new InstantiationService());
		const changes = lifetime.add(new Emitter<void>());
		const picks = new ChatContextPickService();
		let title: string | undefined;
		instantiation.registerInstance(IChatContextPickService, picks);
		instantiation.registerInstance(IExtensionService, {
			onDidChange: changes.event,
			getExtensionPointContributions: () => title ? [{ description: { id: 'acme.records' }, value: [{ id: 'records', displayName: title, icon: '$(file)' }] }] : [],
		} as unknown as IExtensionService);
		instantiation.registerInstance(IChatContextService, lifetime.add(instantiation.createInstance(ChatContextService)));
		lifetime.add(instantiation.createInstance(ChatContextContribution));
		assert.deepEqual([...picks.items], []);
		title = 'Records';
		changes.fire();
		assert.deepEqual([...picks.items].map(item => item.label), ['Records']);
		changes.fire();
		assert.equal([...picks.items].length, 1);
		title = 'Updated records';
		changes.fire();
		assert.deepEqual([...picks.items].map(item => item.label), ['Updated records']);
		title = undefined;
		changes.fire();
		assert.deepEqual([...picks.items], []);
	});

	test('workspace values use provider identities and disappear on unregister', () => {
		using f = setup();
		const provider = { provideWorkspaceChatContext: async () => [] };
		f.service.registerChatWorkspaceContextProvider('first', provider);
		f.service.registerChatWorkspaceContextProvider('second', provider);
		f.service.updateWorkspaceContextItems('first', [{ handle: 1, label: 'Same', value: '' }]);
		f.service.updateWorkspaceContextItems('second', [{ handle: 1, label: 'Same', value: 'second' }, { handle: 2 }]);
		const snapshot = f.service.getWorkspaceContextItems();
		assert.deepEqual(snapshot, [
			{ id: 'first:1', name: 'Same', kind: 'workspace', value: '', modelDescription: undefined },
			{ id: 'second:1', name: 'Same', kind: 'workspace', value: 'second', modelDescription: undefined },
		]);
		f.service.unregisterChatContextProvider('first');
		f.service.updateWorkspaceContextItems('first', [{ handle: 1, value: 'late' }]);
		assert.deepEqual(f.service.getWorkspaceContextItems(), [snapshot[1]]);
		assert.equal(snapshot[0].value, '');
	});

	test('explicit source activates, filters, resolves and captures content once', async () => {
		using f = setup();
		const item: IChatContextItem = { handle: 7, label: 'Record', command: { id: 'source.open' } };
		let resolves = 0;
		const opened: number[] = [];
		f.service.setExecuteCommandCallback(async handle => { opened.push(handle); });
		f.service.setChatContextProvider('test.records', { title: 'Records', icon: Lxicon.file });
		f.service.registerChatExplicitContextProvider('test.records', {
			provideChatContext: async () => [item, { handle: 8, label: 'Other' }],
			resolveChatContext: async context => { resolves++; return { ...context, value: 'captured' }; },
		});
		const source = [...f.picks.items][0];
		assert.equal(source.type, 'pickerPick');
		if (source.type !== 'pickerPick') assert.fail();
		using cancellation = new CancellationTokenSource();
		const picker = source.asPicker();
		assert.equal(typeof picker.picks, 'function');
		if (typeof picker.picks !== 'function') assert.fail();
		const state = picker.picks(observableValue('query', 'record'), cancellation.token);
		const ready = new DeferredPromise<void>();
		using listener = autorun(reader => { if (!state.read(reader).busy) void ready.complete(); });
		await ready.p;
		const [pick] = state.get().picks;
		assert.equal(state.get().picks.length, 1);
		assert.ok(isChatContextPickerPickItem(pick));
		const attachment = await pick.asAttachment();
		assert.ok(attachment && attachment !== 'noop' && !Array.isArray(attachment));
		item.value = 'changed after selection';
		assert.deepEqual(await attachment.resolve(), { name: 'Record', content: 'captured' });
		assert.deepEqual(await attachment.resolve(), { name: 'Record', content: 'captured' });
		await attachment.open?.();
		assert.deepEqual(opened, [7]);
		assert.deepEqual(f.activations, []);
		assert.equal(resolves, 1);
		f.service.unregisterChatContextProvider('test.records');
		await assert.rejects(attachment.open!(), /cancel/i);
		cancellation.cancel();
	});

	test('the first explicit acquisition waits for lazy activation and uses the new registration', async () => {
		let service: ChatContextService | undefined;
		using f = setup(() => service!.registerChatExplicitContextProvider('lazy', {
			provideChatContext: async () => [{ handle: 1, label: 'Lazy record', value: 'Ready' }],
			resolveChatContext: async item => item,
		}));
		service = f.service;
		service.setChatContextProvider('lazy', { title: 'Lazy records', icon: Lxicon.file });
		const source = [...f.picks.items][0];
		if (source.type !== 'pickerPick') assert.fail();
		using cancellation = new CancellationTokenSource();
		const picks = source.asPicker().picks;
		if (typeof picks !== 'function') assert.fail();
		const state = picks(observableValue('query', ''), cancellation.token);
		const ready = new DeferredPromise<void>();
		using listener = autorun(reader => { if (!state.read(reader).busy) void ready.complete(); });
		await ready.p;
		assert.deepEqual(f.activations, ['onChatContextProvider:lazy']);
		assert.equal(state.get().picks[0].label, 'Lazy record');
		cancellation.cancel();
	});

	test('resource matching skips non-matches and falls through empty higher-ranked providers', async () => {
		using f = setup();
		const calls: string[] = [];
		for (const [id, selector, item] of [
			['wrong', { viewType: 'other' }, { handle: 1, value: 'wrong' }],
			['exact', { uri: { scheme: 'file', language: 'typescript' } }, undefined],
			['fallback', { uri: '*' }, { handle: 3, resourceUri: URI.file('/record') }],
		] as const) {
			f.service.registerChatResourceContextProvider(id, selector, {
				provideChatContext: async () => { calls.push(id); return item; },
				resolveChatContext: async context => ({ ...context, value: 'full content' }),
			});
		}
		const context = await f.service.contextForResource(URI.file('/source.ts'), 'typescript', 'text');
		assert.ok(context);
		assert.deepEqual(calls, ['exact', 'fallback']);
		assert.equal((await f.service.resolveChatContext(context)).value, 'full content');
		f.service.unregisterChatContextProvider('fallback');
		await assert.rejects(f.service.resolveChatContext(context), /cancel/i);
	});

	test('unregister cancels an in-flight resource request and rejects its late response', async () => {
		using f = setup();
		const result = new DeferredPromise<IChatContextItem>();
		let token = CancellationToken.None;
		f.service.registerChatResourceContextProvider('slow', { uri: '*' }, {
			provideChatContext: async (_uri, _withValue, _viewType, cancellation) => { token = cancellation; return result.p; },
			resolveChatContext: async item => item,
		});
		const pending = f.service.contextForResource(URI.file('/source.ts'));
		f.service.unregisterChatContextProvider('slow');
		assert.equal(token.isCancellationRequested, true);
		void result.complete({ handle: 1, value: 'late' });
		await assert.rejects(pending, /cancel/i);
	});
});
