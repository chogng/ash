import { IScreenCaptureSetupService } from '../../../screenshotTool/electron-browser/screenCaptureSetup.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatUserImageAttachmentService } from '../../browser/attachments/chatUserImageAttachments.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatInputNoticeHost } from '../../browser/widget/input/chatInputNoticeHost.js';
import { IScreenshotToolService } from '../../../../contrib/screenshotTool/browser/screenshotTool.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IContextKeyService, type ContextKeyChangeEvent } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatWidgetService, type IChatWidget } from '../../browser/chat.js';
import { IChatContextPickService, type IChatContextValueItem } from '../../browser/attachments/chatContextPickService.js';
import { IAppWindowScreenshotService } from '../../../screenshotTool/electron-browser/appWindowScreenshot.js';
import { ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID } from '../../common/constants.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { commandActionLabel } from '../../../../../platform/action/common/action.js';
import { MenusRegistry, MenuId } from '../../../../../platform/actions/common/actions.js';

suite('App window screenshot commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	let Contribution: typeof import('../../electron-browser/actions/chatAppWindowScreenshotActions.js').AppWindowScreenshotContribution;
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', {
			configurable: true, value: {
				ipcRenderer: {
					invoke: async () => ({ available: false, activeLabel: '' }),
					on: () => ({ dispose() { } }),
				}
			}
		});
		Contribution = (await import('../../electron-browser/actions/chatAppWindowScreenshotActions.js')).AppWindowScreenshotContribution;
	});
	suiteTeardown(() => {
		if (previous) Object.defineProperty(globalThis, 'ash', previous);
		else Reflect.deleteProperty(globalThis, 'ash');
	});

	function fixture(lifetime: DisposableStore, context?: IContextKeyService) {
		const services = lifetime.add(new InstantiationService());
		const changed = lifetime.add(new Emitter<ContextKeyChangeEvent>());
		const calls: string[] = [];
		const configured = lifetime.add(new Emitter<import('../../../../../platform/configuration/common/configuration.js').IConfigurationChangeEvent>());
		const state = { enabled: true, feature: true, images: true, context: undefined as IChatContextValueItem | undefined };
		const widget = {
			sessionId: 'source', threadId: 'thread', visible: true, onDidChangeViewModel: Event.None, onDidHide: Event.None, domNode: document.createElement('div'), input: {
				supportsImages: () => state.images,
				inputUri: URI.parse('ash-chat-input:/test'),
				noticeHost: lifetime.add(new ChatInputNoticeHost(() => { })),
				attachmentHintContainerElement: document.createElement('div'),
				attachmentModel: { attachments: [], onDidChange: Event.None },
				captureScreenshot: async (capture: (signal: AbortSignal) => Promise<unknown>) => { calls.push('draft'); await capture(new AbortController().signal); },
			}
		} as unknown as IChatWidget;
		services.registerInstance(IContextKeyService, context ?? { createKey: () => ({ set() { }, reset() { } }), contextMatchesRules: () => state.enabled, onDidChangeContext: changed.event } as unknown as IContextKeyService);
		services.registerInstance(IConfigurationService, { getValue: (key: string) => key === ChatConfiguration.AppWindowScreenshotsEnabled ? state.feature : true, onDidChangeConfiguration: configured.event } as unknown as IConfigurationService);
		services.registerInstance(IKeybindingService, { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService);
		services.registerInstance(ICommandService, { executeCommand: async () => { } } as unknown as ICommandService);
		services.registerInstance(INotificationService, { info: () => { calls.push('unsupported'); }, error: () => { calls.push('error'); } } as unknown as INotificationService);
		services.registerInstance(IScreenCaptureSetupService, { show: async () => { calls.push('setup'); } });
		services.registerInstance(INativeHostService, { focusWindow: async () => { calls.push('focus'); } } as INativeHostApi);
		services.registerInstance(IViewsService, { openView: async () => { calls.push('open'); } } as unknown as IViewsService);
		services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
		services.registerInstance(IChatWidgetService, { onDidChangeWidgets: Event.None, lastFocusedWidget: widget, getAllWidgets: () => [widget] } as unknown as IChatWidgetService);
		services.registerInstance(IChatUserImageAttachmentService, { onDidAttachImages: Event.None, didAttachImages() { } });
		services.registerInstance(IStorageService, { get: () => undefined, onDidChangeValue: Event.None } as unknown as IStorageService);
		services.registerInstance(ILogService, { error() { } } as unknown as ILogService);
		services.registerInstance(IAppWindowScreenshotService, { hasCaptured: false, onDidChangeHasCaptured: Event.None, getPermission: async () => 'granted', requestPermission: async () => { }, capture: async options => { calls.push(options?.pick ? 'pick' : 'capture'); return { kind: 'captured', target: 'frontmost', window: { sourceId: 'window:42:0', title: 'Synthetic app' }, image: { dataUrl: 'data:image/png;base64,AQ==', width: 1, height: 1 } }; } });
		services.registerInstance(IScreenshotToolService, { captureAndEdit: async () => { calls.push('edit'); return VSBuffer.wrap(new Uint8Array([1])); } } as unknown as IScreenshotToolService);
		services.registerInstance(IChatContextPickService, {
			registerChatContextItem: (source: IChatContextValueItem) => {
				state.context = source;
				return toDisposable(() => { state.context = undefined; });
			}
		} as unknown as IChatContextPickService);
		lifetime.add(services.createInstance(Contribution));
		return { services, calls, state, changed, widget, configured, run: (id = ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID, args?: unknown) => Promise.resolve(services.invokeFunction(CommandsRegistry.getCommand(id)!, args)) };
	}

	test('the production contribution projects the configuration into the command context', () => {
		using lifetime = new DisposableStore();
		const context = lifetime.add(new ContextKeyService());
		context.createKey(ChatContextKeys.enabled.key, true);
		const f = fixture(lifetime, context);
		const expression = ContextKeyExpr.equals(`config.${ChatConfiguration.AppWindowScreenshotsEnabled}`, true);
		assert.equal(context.contextMatchesRules(expression), true);
		assert.ok(f.state.context);
		f.state.feature = false;
		f.configured.fire({ source: 8 as import('../../../../../platform/configuration/common/configuration.js').ConfigurationTarget, affectedKeys: new Set([ChatConfiguration.AppWindowScreenshotsEnabled]), change: { keys: [ChatConfiguration.AppWindowScreenshotsEnabled], overrides: [] }, affectsConfiguration: () => true });
		assert.equal(context.contextMatchesRules(expression), false);
		assert.equal(f.state.context, undefined);
	});

	test('command capture uses the original composer lease without opening another view', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		await f.run();
		assert.deepEqual(f.calls, ['draft', 'capture', 'edit', 'focus']);
		await f.run('workbench.action.chat.pickAppWindowScreenshot');
		assert.deepEqual(f.calls, ['draft', 'capture', 'edit', 'focus', 'draft', 'pick', 'edit', 'focus']);
	});
	test('explicit session resources are validated and resolve the existing target', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		await f.run(ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID, { sessionResource: LocalChatSessionUri.forSession('source', 'thread') });
		assert.deepEqual(f.calls, ['draft', 'capture', 'edit', 'focus']);
		await assert.rejects(f.run(ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID, { sessionResource: 'source' }), /Chat session resource/);
		assert.deepEqual(f.calls, ['draft', 'capture', 'edit', 'focus']);
	});
	test('AI or configuration disablement removes Add Context and gates programmatic calls', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		assert.ok(f.state.context);
		f.state.enabled = false;
		f.changed.fire({ keys: new Set(['chat.enabled']), affectsSome: () => true });
		assert.equal(f.state.context, undefined);
		await f.run();
		assert.deepEqual(f.calls, []);
	});
	test('unsupported models reject before acquiring window pixels', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		f.state.images = false;
		assert.equal(f.state.context!.isEnabled?.(f.widget), false);
		await f.run();
		assert.deepEqual(f.calls, ['unsupported']);
	});
	test('Chinese command titles and Add Context labels use the client catalog', () => {
		initializeTestLocalization('zh-CN');
		try {
			using lifetime = new DisposableStore(); const f = fixture(lifetime);
			assert.equal(f.state.context!.label, '截取应用窗口…');
			const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => 'command' in item && item.command.id === ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID);
			assert.ok(item && 'command' in item);
			assert.equal(commandActionLabel(item.command.title), '附加应用窗口截图');
		} finally { resetNlsResolver(); }
	});
});
