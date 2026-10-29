import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { suite, suiteTeardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuDelegate } from '../../../../../../base/browser/contextmenu.js';
import { ModifierKeyEmitter } from '../../../../../../base/browser/dom.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import {
	buildOpenSessionLinkUri,
	parseOpenSessionLinkUri,
} from '../../../../../../platform/agentHost/common/openSessionLink.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IMenuService, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IOpenerService, type IOpener } from '../../../../../../platform/opener/common/opener.js';
import { IChatService } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatSessionLinkOpener, CopyChatSessionLinkAction } from '../../../browser/actions/chatCopyActions.js';
import { ChatViewTitleControl } from '../../../browser/widgetHosts/viewPane/chatViewTitleControl.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';

suite('Conversation links', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const registration = registerAction2(CopyChatSessionLinkAction);
	suiteTeardown(() => registration.dispose());

	function fixture(lifetime: DisposableStore) {
		const services = lifetime.add(new InstantiationService());
		let active: { sessionId: string; threadId: string } | undefined = { sessionId: 'active', threadId: 'root' };
		let generation = 1;
		const stateListeners = new Set<(state: 'stopped') => void>();
		let registered: IOpener | undefined;
		let read = async (sessionId: string, threadId: string) => ({ thread: { sessionId, threadId } });
		const opened: unknown[] = [];
		const copied: string[] = [];
		const announcements: string[] = [];
		services.registerInstance(IAccessibilityService, {
			status: message => {
				announcements.push(message);
			},
		} as IAccessibilityService);
		services.registerInstance(IAppServerApi, {
			get connectionGeneration() {
				return generation;
			},
			getConnectionState: async () => 'ready',
			getSlashCommands: async () => [],
			onConnectionState: listener => {
				stateListeners.add(listener);
				return toDisposable(() => stateListeners.delete(listener));
			},
		} as IAppServerApi);
		services.registerInstance(IChatService, {
			readThread: (sessionId, threadId) => read(sessionId, threadId),
		} as IChatService);
		services.registerInstance(IClipboardService, {
			writeText: async value => {
				copied.push(value);
			},
		} as IClipboardService);
		const navigation = {
			getActiveConversation: () => active,
			openConversation: async (sessionId, threadId) => {
				opened.push({ sessionId, threadId });
			},
		} as IChatSessionNavigationService;
		services.registerInstance(IChatSessionNavigationService, navigation);
		services.registerInstance(IOpenerService, {
			registerOpener: opener => {
				registered = opener;
				return toDisposable(() => {
					registered = undefined;
				});
			},
		} as IOpenerService);
		lifetime.add(services.createInstance(ChatSessionLinkOpener));
		return {
			copied,
			opened,
			announcements,
			routeWith: (
				prepare: NonNullable<IChatSessionNavigationService['prepareConversationLink']>,
				open: NonNullable<IChatSessionNavigationService['openConversationLink']>,
			) => {
				navigation.prepareConversationLink = prepare;
				navigation.openConversationLink = open;
			},
			title: (container: HTMLElement, showContextMenu: (menu: IContextMenuDelegate) => void) => {
				const commands = lifetime.add(new CommandService(services));
				const keys = lifetime.add(new ContextKeyService());
				services.registerInstance(IMenuService, new MenuService(commands, keys));
				services.registerInstance(IContextMenuService, { showContextMenu } as IContextMenuService);
				return lifetime.add(
					services.createInstance(ChatViewTitleControl, container, 'chat-link', async () => {}),
				);
			},
			copy: (context?: unknown) =>
				Promise.resolve(
					services.invokeFunction(
						CommandsRegistry.getCommand('workbench.action.chat.copySessionLink')!,
						context,
					),
				),
			open: (uri: URI) => registered!.open(uri),
			select: (value: typeof active) => {
				active = value;
			},
			readWith: (value: typeof read) => {
				read = value;
			},
			reconnect: () => {
				generation++;
			},
			close: () => {
				for (const listener of stateListeners) listener('stopped');
			},
		};
	}

	test('the conversation title menu copies its opening target after selection changes', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using lifetime = new DisposableStore();
			const f = fixture(lifetime);
			let menu: IContextMenuDelegate | undefined;
			const control = f.title(dom.window.document.body, value => {
				menu = value;
			});
			const title = dom.window.document.querySelector<HTMLButtonElement>('.ash-chat-view-title-button')!;
			const event = new dom.window.MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: 40,
				clientY: 60,
			});
			title.dispatchEvent(event);
			assert.ok(event.defaultPrevented);
			assert.deepEqual(menu!.getAnchor(), { x: 40, y: 60, targetWindow: dom.window });
			const copy = menu!.getActions().find(action => action.id === 'workbench.action.chat.copySessionLink')!;
			assert.equal(copy.label, 'Copy Conversation Link');
			f.select({ sessionId: 'later', threadId: 'later-peer' });
			await copy.run();
			assert.deepEqual(
				f.copied.map(value => parseOpenSessionLinkUri(URI.parse(value))),
				[{ connectionAuthority: 'local', sessionId: 'active', threadId: 'root' }],
			);
			menu!.onHide!(true);
			assert.equal(dom.window.document.activeElement, title);
			control.dispose();
			assert.ok(menu!.cancellationToken!.isCancellationRequested);
		} finally {
			ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
			dom.window.close();
		}
	});

	test('keyboard title menus retain an unsaved draft instead of falling back to another conversation', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using lifetime = new DisposableStore();
			const f = fixture(lifetime);
			let menu: IContextMenuDelegate | undefined;
			f.title(dom.window.document.body, value => {
				menu = value;
			});
			const title = dom.window.document.querySelector<HTMLButtonElement>('.ash-chat-view-title-button')!;
			for (const key of ['F10', 'ContextMenu']) {
				f.select(undefined);
				const event = new dom.window.KeyboardEvent('keydown', {
					key,
					shiftKey: key === 'F10',
					bubbles: true,
					cancelable: true,
				});
				title.dispatchEvent(event);
				assert.ok(event.defaultPrevented);
				assert.equal(menu!.getAnchor(), title);
				f.select({ sessionId: 'later', threadId: 'later-peer' });
				const copy = menu!.getActions().find(action => action.id === 'workbench.action.chat.copySessionLink')!;
				await assert.rejects(Promise.resolve(copy.run()), /Send a message/);
				menu!.onHide!(true);
				assert.equal(dom.window.document.activeElement, title);
			}
			assert.deepEqual(f.copied, []);
		} finally {
			ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
			dom.window.close();
		}
	});

	test('copies the explicit command target and opens its exact IDs without inferring a root', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		const pending = new DeferredPromise<{ thread: { sessionId: string; threadId: string } }>();
		f.readWith(() => pending.p);
		const copying = f.copy({ sessionId: 'chosen', threadId: 'peer/%?#' });
		f.select({ sessionId: 'other', threadId: 'other-root' });
		await pending.complete({ thread: { sessionId: 'chosen', threadId: 'peer/%?#' } });
		await copying;
		assert.deepEqual(f.announcements, ['Conversation link copied to clipboard']);
		assert.deepEqual(
			f.copied.map(value => parseOpenSessionLinkUri(URI.parse(value))),
			[{ connectionAuthority: 'local', sessionId: 'chosen', threadId: 'peer/%?#' }],
		);
		f.readWith(async (sessionId, threadId) => ({ thread: { sessionId, threadId } }));
		assert.equal(await f.open(URI.parse(f.copied[0]!)), true);
		assert.deepEqual(f.opened, [{ sessionId: 'chosen', threadId: 'peer/%?#' }]);
	});

	test('multi-host copy and open delegate raw coordinates to their owner without reading the ambient connection', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		const qualified = 'qualified:' + 'workspace/'.repeat(50);
		f.select({ sessionId: qualified, threadId: 'qualified-thread' });
		f.readWith(async () => {
			assert.fail('the ambient backend cannot validate another host');
		});
		const address = {
			sessionId: 'backend-session',
			threadId: 'backend-thread',
			connectionAuthority: 'opaque-provider',
		};
		const opened: unknown[] = [];
		f.routeWith(
			async (sessionId, threadId) => {
				assert.deepEqual({ sessionId, threadId }, { sessionId: qualified, threadId: 'qualified-thread' });
				return address;
			},
			async value => {
				opened.push(value);
			},
		);
		await f.copy();
		assert.deepEqual(parseOpenSessionLinkUri(URI.parse(f.copied[0]!)), address);
		assert.equal(await f.open(URI.parse(f.copied[0]!)), true);
		assert.deepEqual(opened, [address]);
	});

	test('rejects a different connection, malformed links, unavailable identities and draft copies', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		let reads = 0;
		f.readWith(async () => {
			reads++;
			return { thread: { sessionId: 'different', threadId: 'root' } };
		});
		await assert.rejects(f.open(buildOpenSessionLinkUri('active', 'root', 'remote')), /connection.*unavailable/);
		for (const query of [
			'sessionId=active',
			'sessionId=active&threadId=root&threadId=peer',
			'sessionId=active&threadId=%00',
		]) {
			await assert.rejects(
				f.open(URI.from({ scheme: 'agent-host-session', authority: 'local', path: '/open', query })),
				/invalid/,
			);
		}
		assert.equal(reads, 0);
		await assert.rejects(f.open(buildOpenSessionLinkUri('active', 'root', 'local')), /unavailable/);
		f.select(undefined);
		await assert.rejects(f.copy(), /Send a message/);
		assert.deepEqual({ opened: f.opened, copied: f.copied, reads }, { opened: [], copied: [], reads: 1 });
	});

	for (const operation of ['copy', 'open'] as const) {
		for (const retirement of ['reconnect', 'close'] as const)
			test(`a ${retirement} cannot complete a pending ${operation}`, async () => {
				using lifetime = new DisposableStore();
				const f = fixture(lifetime);
				const pending = new DeferredPromise<{ thread: { sessionId: string; threadId: string } }>();
				f.readWith(() => pending.p);
				const result =
					operation === 'copy' ? f.copy() : f.open(buildOpenSessionLinkUri('active', 'root', 'local'));
				const rejected = assert.rejects(result, /cancelled/);
				f[retirement]();
				await pending.complete({ thread: { sessionId: 'active', threadId: 'root' } });
				await rejected;
				assert.deepEqual({ opened: f.opened, copied: f.copied }, { opened: [], copied: [] });
			});
	}

	test('Chinese link errors come from the product translation catalog', async () => {
		const messages = JSON.parse(
			readFileSync(resolve('extensions/language-pack-zh-cn/translations/chat.json'), 'utf8'),
		);
		setNlsMessages('zh-CN', messages);
		try {
			// Product commands are registered after localization during startup.
			registration.dispose();
			using translatedAction = registerAction2(CopyChatSessionLinkAction);
			using lifetime = new DisposableStore();
			const f = fixture(lifetime);
			const dom = new JSDOM('<!doctype html><body></body>');
			try {
				let menu: IContextMenuDelegate | undefined;
				f.title(dom.window.document.body, value => {
					menu = value;
				});
				dom.window.document
					.querySelector<HTMLButtonElement>('.ash-chat-view-title-button')!
					.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
				assert.equal(
					menu!.getActions().find(action => action.id === 'workbench.action.chat.copySessionLink')!.label,
					'复制对话链接',
				);
			} finally {
				ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
				dom.window.close();
			}
			f.select(undefined);
			await assert.rejects(f.copy(), { message: '请先在此对话中发送消息，再复制链接。' });
			await assert.rejects(f.open(buildOpenSessionLinkUri('active', 'root', 'remote')), {
				message: '此对话链接所属的连接不可用。',
			});
		} finally {
			resetNlsResolver();
		}
	});
});
