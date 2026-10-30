import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import {
	ChatContextPickService, IChatContextPickService, type IChatContextPickerItem, isChatContextPickerPickItem,
} from '../../../chat/browser/attachments/chatContextPickService.js';
import {
	ICanvasContextService, ICanvasService, type ICanvasContext, type ICanvasDefinition,
	type ICanvasOwner, type ICanvasReference, type ICanvasReopenTarget, isCanvasOwner,
} from '../../common/canvas.js';
import { registerEditorCanvasActions } from '../../browser/editorCanvasActions.js';
import { registerCanvasContextPicker } from '../../browser/canvasContextPicker.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

suite('Canvas menu actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	const board: ICanvasDefinition = { canvasId: 'board', extensionId: 'test.canvas', extensionSource: 'user', displayName: 'Board', description: '', requiresInput: false };
	const owner = (id: string) => ({ providerId: 'local-agent-host', session: URI.parse('ash-session:/' + id), chat: URI.parse('ash-thread:/' + id) });

	function fixture() {
		const resources = new DisposableStore();
		const services = resources.add(new InstantiationService());
		const keys = resources.add(new ContextKeyService());
		const visibility = resources.add(new Emitter<void>());
		const definitionsChanged = resources.add(new Emitter<void>());
		const enabled = observableValue('canvas enabled', true);
		const contexts = observableValue<readonly ICanvasContext[]>('canvas contexts', []);
		const reopenable = observableValue<readonly ICanvasReopenTarget[]>('reopenable', []);
		const opened: string[] = [];
		const reopened: string[] = [];
		const errors: unknown[] = [];
		const picks = new ChatContextPickService();
		let active: { sessionId: string; threadId: string; } | undefined;
		let listing = async (): Promise<readonly ICanvasDefinition[] | undefined> => [board];
		const context: ICanvasContext = {
			owner: owner('one'), canvases: constObservable([]),
			definitionProvider: {
				onDidChangeDefinitions: definitionsChanged.event,
				listCanvases: () => listing(),
				openCanvas: async (_definition, instanceId) => { opened.push(instanceId); },
			},
		};
		services.registerInstance(IContextKeyService, keys);
		services.registerInstance(ILogService, { error: (value: unknown) => { errors.push(value); } } as unknown as ILogService);
		services.registerInstance(INotificationService, { error: (value: unknown) => { errors.push(value); } } as unknown as INotificationService);
		services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => active } as IChatSessionNavigationService);
		services.registerInstance(IChatWidgetService, { onDidChangeWidgets: visibility.event } as IChatWidgetService);
		services.registerInstance(IChatContextPickService, picks);
		services.registerInstance(ICanvasContextService, {
			contexts, onDidChangeVisibility: visibility.event,
			isOwnerVisible: (target: ICanvasOwner) => enabled.get() && ai.get() === true && contexts.get().some(context => isCanvasOwner(context.owner, target)),
		} as unknown as ICanvasContextService);
		services.registerInstance(ICanvasService, {
			enabled, reopenableCanvases: reopenable,
			isOwnerPresentable: (reference: ICanvasReference) => reopenable.get().some(target => target.reference.canvas.toString() === reference.canvas.toString()),
			reopenCanvas: async (reference: ICanvasReference) => { reopened.push(reference.canvas.toString()); },
		} as unknown as ICanvasService);
		const ai = ChatContextKeys.enabled.bindTo(keys);
		ai.set(true);
		const commands = resources.add(new CommandService(services));
		const menus = new MenuService(commands, keys);
		resources.add(registerEditorCanvasActions(services));
		resources.add(registerCanvasContextPicker(services));
		const source = () => [...picks.items][0] as IChatContextPickerItem;
		const menu = () => menus.getMenuActions(MenuId.ChatNewMenu).flatMap(([, actions]) => actions).filter((action): action is SubmenuItemAction => action instanceof SubmenuItemAction);
		return {
			context, contexts, enabled, reopenable, ai, opened, reopened, errors, services, menus, menu, source,
			select(id?: string) { active = id ? { sessionId: id, threadId: id } : undefined; visibility.fire(); },
			list(value: typeof listing) { listing = value; definitionsChanged.fire(); },
			[Symbol.dispose]() { resources.dispose(); },
		};
	}

	for (const locale of ['en', 'zh-CN']) test(`Canvas appears only inside menus for the selected initialized conversation in ${locale}`, async () => {
		try {
			if (locale === 'zh-CN') setNlsMessages(locale, productLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles);
			using f = fixture();
			f.contexts.set([f.context], undefined);
			assert.deepEqual(f.menu(), []);
			assert.equal(await f.source().isEnabled!(), false);
			f.select('one');
			await settle();
			assert.deepEqual(f.menu().map(menu => ({ label: menu.label, children: menu.actions.map(action => action.label) })), [{ label: 'Canvas', children: ['Board'] }]);
			assert.equal(f.source().label, 'Canvas…');
			assert.equal(await f.source().isEnabled!(), true);
			assert.deepEqual(f.menus.getMenuActions(MenuId.ChatTitle), []);
			assert.deepEqual(f.menus.getMenuActions(MenuId.ChatInputSecondary), []);
			const offered = f.menu()[0]!.actions[0]!;
			f.reopenable.set([], undefined);
			assert.equal(f.menu()[0]!.actions[0]!.id, offered.id);
			await offered.run();
			assert.equal(f.opened.length, 1);
			const staleCommand = CommandsRegistry.getCommand(f.menu()[0]!.actions[0]!.id)!;
			f.select('two');
			assert.deepEqual(f.menu(), []);
			assert.equal(await f.source().isEnabled!(), false);
			await staleCommand(f.services);
			assert.equal(f.opened.length, 1);
			f.select('one'); await settle();
			f.enabled.set(false, undefined);
			assert.deepEqual(f.menu(), []);
			assert.equal(await f.source().isEnabled!(), false);
			f.enabled.set(true, undefined); await settle();
			f.ai.set(false);
			assert.deepEqual(f.menu(), []);
			assert.equal(await f.source().isEnabled!(), false);
			assert.deepEqual(f.errors, []);
		} finally { resetNlsResolver(); }
	});

	test('empty, unknown and input-required catalogs stay hidden, while a dismissed Canvas can reopen', async () => {
		using f = fixture();
		f.list(async () => [{ ...board, requiresInput: true }]);
		f.contexts.set([f.context], undefined); f.select('one'); await settle();
		assert.deepEqual(f.menu(), []);
		assert.equal(await f.source().isEnabled!(), false);
		f.list(async () => undefined); await settle();
		assert.deepEqual(f.menu(), []);
		assert.equal(await f.source().isEnabled!(), false);
		f.list(async () => []); await settle();
		assert.deepEqual(f.menu(), []);
		const target: ICanvasReopenTarget = { reference: { ...f.context.owner, canvas: URI.parse('canvas:/saved') }, canvas: { resource: URI.parse('canvas:/saved'), instanceId: 'saved', title: 'Saved board', source: URI.parse('https://example.test') } };
		f.reopenable.set([target, { ...target, reference: { ...owner('two'), canvas: URI.parse('canvas:/other') } }], undefined);
		assert.deepEqual(f.menu()[0]!.actions.map(action => action.label), ['Saved board']);
		await f.menu()[0]!.actions[0]!.run();
		assert.deepEqual(f.reopened, ['canvas:/saved']);
		f.reopenable.set([], undefined);
		assert.deepEqual(f.menu(), []);
	});

	test('a late availability read and a retained context choice cannot cross conversations', async () => {
		using f = fixture();
		f.contexts.set([f.context], undefined); f.select('one'); await settle();
		const picker = f.source().asPicker();
		try {
			assert.equal(typeof picker.picks, 'function');
			if (typeof picker.picks !== 'function') return;
			const { CancellationToken } = await import('../../../../../base/common/cancellation.js');
			const results = picker.picks(constObservable(''), CancellationToken.None);
			await settle();
			const choice = results.get().picks.find(isChatContextPickerPickItem)!;
			const pending = promiseWithResolvers<readonly ICanvasDefinition[]>();
			f.list(() => pending.promise);
			const available = f.source().isEnabled!();
			f.select();
			pending.resolve([board]);
			assert.equal(await available, false);
			assert.deepEqual(results.get().picks, []);
			assert.equal(await choice.asAttachment(), 'noop');
			assert.deepEqual(f.opened, []);
		} finally { picker.dispose?.(); }
	});
});
