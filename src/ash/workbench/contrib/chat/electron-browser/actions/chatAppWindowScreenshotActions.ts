import { IImageResizeService } from '../../../../../platform/imageResize/common/imageResizeService.js';
import { Event } from '../../../../../base/common/event.js';
import { AppWindowScreenshotHint } from './chatAppWindowScreenshotHint.js';
import { getAppWindowScreenshotSetupOptions } from './chatAppWindowScreenshotSetup.js';
import { IScreenCaptureSetupService } from '../../../screenshotTool/electron-browser/screenCaptureSetup.js';
import { IScreenshotToolService } from '../../../screenshotTool/browser/screenshotTool.js';
import type { VSBuffer } from '../../../../../base/common/buffer.js';
import { getScreenshotToolImageData } from '../../../screenshotTool/browser/screenshotTool.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { getKeybindingLabel } from '../../../../../base/common/keybindingLabels.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IAppWindowScreenshotService } from '../../../screenshotTool/electron-browser/appWindowScreenshot.js';
import { IChatContextPickService, type IChatContextValueItem } from '../../browser/attachments/chatContextPickService.js';
import { convertBufferToScreenshotVariable } from '../../browser/attachments/chatScreenshotContext.js';
import { IChatWidgetService, type IChatWidget, type IChatViewPane } from '../../browser/chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_VIEW_ID } from '../../common/chat.js';
import { ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID, ChatConfiguration } from '../../common/constants.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { invoke, subscribe } from '../../../../../platform/ipc/electron-browser/rendererIpc.js';
import { GLOBAL_KEYBINDING_UPDATE_CHANNEL, GLOBAL_KEYBINDING_TRIGGER_CHANNEL, validateGlobalKeybindingResult } from '../../../../../platform/globalKeybindings/common/globalKeybindings.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { toElectronAccelerator } from '../../../../../platform/keybinding/common/electronAccelerator.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IChatContextTarget, ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

const PICK_APP_WINDOW_SCREENSHOT_COMMAND_ID = 'workbench.action.chat.pickAppWindowScreenshot';
const enabled = ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ContextKeyExpr.equals(`config.${ChatConfiguration.AppWindowScreenshotsEnabled}`, true));

async function captureAppWindowScreenshot(screenshots: IAppWindowScreenshotService, imageEditors: IScreenshotToolService, native: INativeHostApi, setup: IScreenCaptureSetupService, pick: boolean, signal: AbortSignal): Promise<VSBuffer | undefined> {
	const result = await screenshots.capture({ pick, signal });
	if (signal.aborted) {
		return undefined;
	}
	if (result.kind === 'permissionRequired') {
		await native.focusWindow();
		if (signal.aborted) { return undefined; }
		await setup.show(getAppWindowScreenshotSetupOptions(), signal);
		return undefined;
	}
	if (result.kind === 'failed') {
		throw new Error(localize('appWindowScreenshot.failed', 'The app window could not be captured. Try picking another window.'));
	}
	if (result.kind !== 'captured') {
		return undefined;
	}
	return imageEditors.captureAndEdit(signal, { image: getScreenshotToolImageData(result.image).data });
}

async function attachAppWindowScreenshot(accessor: ServicesAccessor, pick: boolean, args?: unknown): Promise<void> {
	if (!accessor.get(IContextKeyService).contextMatchesRules(enabled)) {
		return;
	}
	let session: { readonly sessionId: string; readonly threadId: string; } | undefined;
	if (args !== undefined) {
		if (!args || typeof args !== 'object' || !('sessionResource' in args) || !URI.isUri(args.sessionResource)) {
			throw new TypeError('Expected a Chat session resource');
		}
		session = LocalChatSessionUri.parse(args.sessionResource);
		if (!session) {
			throw new TypeError('Expected a Chat session resource');
		}
	}
	const widgets = accessor.get(IChatWidgetService);
	const screenshots = accessor.get(IAppWindowScreenshotService);
	const imageEditors = accessor.get(IScreenshotToolService);
	const native = accessor.get(INativeHostService);
	const setup = accessor.get(IScreenCaptureSetupService);
	const views = accessor.get(IViewsService);
	const navigation = accessor.get(IChatSessionNavigationService);
	const notifications = accessor.get(INotificationService);
	const widget = session ? widgets.getAllWidgets().find(widget => widget.sessionId === session.sessionId && widget.threadId === session.threadId) : widgets.lastFocusedWidget;
	if (widget?.visible) {
		// The input's acquisition lease cancels capture when its draft or conversation changes.
		if (!widget.input.supportsImages()) {
			notifications.info(localize('appWindowScreenshot.noImages', 'This chat does not accept images.'));
			return;
		}
		await widget.input.captureScreenshot(async signal => {
			try {
				return await captureAppWindowScreenshot(screenshots, imageEditors, native, setup, pick, signal);
			} finally {
				if (!signal.aborted) {
					await native.focusWindow(getWindow(widget.domNode).name || undefined);
				}
			}
		});
		return;
	}
	// Opening Chat changes the foreground window. Freeze and edit first, then reveal a destination.
	try {
		const image = await captureAppWindowScreenshot(screenshots, imageEditors, native, setup, pick, new AbortController().signal);
		if (!image) {
			return;
		}
		await native.focusWindow();
		if (session) {
			await navigation.openConversation(session.sessionId, session.threadId);
		}
		const view = await views.openView<IChatViewPane & IChatContextTarget>(CHAT_VIEW_ID);
		await view?.captureScreenshot(async () => image);
	} catch (error) {
		notifications.error(localize('appWindowScreenshot.error', 'Could not attach the app window screenshot: {0}', String(error)));
	}
}

function registerAppWindowScreenshotActions(): DisposableStore {
	const store = new DisposableStore();
	store.add(registerAction2(class AttachAppWindowScreenshotAction extends Action2 {
		constructor() {
			super({
				id: ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID,
				title: localize2('chat.attachAppWindowScreenshot', 'Attach Screenshot of App Window'),
				f1: true, precondition: enabled,
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyS,
					mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyS },
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		public override run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			return attachAppWindowScreenshot(accessor, false, args);
		}
	}));
	store.add(registerAction2(class PickAppWindowScreenshotAction extends Action2 {
		constructor() {
			super({
				id: PICK_APP_WINDOW_SCREENSHOT_COMMAND_ID,
				title: localize2('chat.pickAppWindowScreenshot', 'Pick App Window to Screenshot…'),
				f1: true, precondition: enabled,
			});
		}
		public override run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			return attachAppWindowScreenshot(accessor, true, args);
		}
	}));
	return store;
}

class AppWindowScreenshotContextValuePick implements IChatContextValueItem {
	public readonly type = 'valuePick';
	public readonly presentation = 'inline';
	public readonly ordinal = -190;
	public readonly icon = Lxicon.openPreview;
	public readonly commandId = PICK_APP_WINDOW_SCREENSHOT_COMMAND_ID;
	public get label(): string { return localize('chatContext.appWindowScreenshot', 'Screenshot App Window…'); }
	constructor(
		@IAppWindowScreenshotService private readonly screenshots: IAppWindowScreenshotService,
		@INativeHostService private readonly native: INativeHostApi,
		@IScreenshotToolService private readonly imageEditors: IScreenshotToolService,
		@IScreenCaptureSetupService private readonly setup: IScreenCaptureSetupService,
		@IImageResizeService private readonly imageResize: IImageResizeService,
	) { }
	public isEnabled(widget?: IChatWidget): boolean { return widget?.input.supportsImages() ?? true; }
	public async asAttachment(widget: IChatWidget | undefined, signal: AbortSignal = new AbortController().signal): Promise<ChatContextAttachment | undefined> {
		const image = await captureAppWindowScreenshot(this.screenshots, this.imageEditors, this.native, this.setup, true, signal);
		if (!signal.aborted) {
			await this.native.focusWindow(widget ? getWindow(widget.domNode).name || undefined : undefined);
		}
		if (!image || signal.aborted) {
			return undefined;
		}
		const attachment = await convertBufferToScreenshotVariable(image, this.imageResize);
		return signal.aborted ? undefined : attachment;
	}
}

export class AppWindowScreenshotContribution extends Disposable {
	constructor(
		@IChatContextPickService contexts: IChatContextPickService,
		@IInstantiationService instantiation: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IKeybindingService keybindings: IKeybindingService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IChatWidgetService widgets: IChatWidgetService,
	) {
		super();
		const configured = contextKeys.createKey<boolean | undefined>(`config.${ChatConfiguration.AppWindowScreenshotsEnabled}`, undefined);
		configured.set(configuration.getValue<boolean>(ChatConfiguration.AppWindowScreenshotsEnabled) === true);
		this._register(toDisposable(() => configured.reset()));
		this._register(registerAppWindowScreenshotActions());
		const registration = this._register(new MutableDisposable());
		const hints = this._register(new DisposableMap<IChatWidget>());
		const updateHints = (): void => {
			const current = new Set(widgets.getAllWidgets());
			for (const widget of hints.keys()) { if (!current.has(widget)) { hints.deleteAndDispose(widget); } }
			for (const widget of current) {
				if (hints.has(widget)) { continue; }
				const input = widget.input;
				hints.set(widget, instantiation.createInstance(AppWindowScreenshotHint, {
					inputUri: input.inputUri, noticeHost: input.noticeHost, container: input.attachmentHintContainerElement,
					getAttachmentIds: () => input.attachmentModel.attachments.map(attachment => attachment.id),
					onDidChangeAttachments: input.attachmentModel.onDidChange,
					onDidChangeDraft: Event.any(widget.onDidChangeViewModel, widget.onDidHide),
					focusInput: () => widget.focusInput(),
					canAttachScreenshots: () => widget.visible && !input.replyOnly && input.supportsImages() && contextKeys.contextMatchesRules(enabled),
				}, {
					id: ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID,
					title: localize('chat.attachAppWindowScreenshot', 'Attach Screenshot of App Window'),
					run: () => {
						const resource = widget.sessionId && widget.threadId ? LocalChatSessionUri.forSession(widget.sessionId, widget.threadId) : undefined;
						void commands.executeCommand(ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID, resource ? { sessionResource: resource } : undefined).catch(error => notifications.error(String(error)));
					},
				}));
			}
		};
		this._register(widgets.onDidChangeWidgets(updateHints));
		updateHints();

		const lease = { id: 'chat.appWindowScreenshot', commandId: ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID };
		let pending = Promise.resolve();
		let lastFailure = '';
		const syncShortcut = (): void => {
			pending = pending.then(async () => {
				if (this.isDisposed) {
					return;
				}
				const binding = keybindings.lookupKeybinding(ATTACH_APP_WINDOW_SCREENSHOT_COMMAND_ID);
				const accelerator = binding ? toElectronAccelerator(binding) : undefined;
				const global = contextKeys.contextMatchesRules(enabled) && !!accelerator;
				const result = validateGlobalKeybindingResult(await invoke(GLOBAL_KEYBINDING_UPDATE_CHANNEL, {
					...lease, accelerator: accelerator ?? '', label: binding ? getKeybindingLabel(binding) : '', global,
				}));
				if (this.isDisposed) {
					return;
				}
				const failure = global && !result.available && binding ? getKeybindingLabel(binding) : '';
				if (failure && failure !== lastFailure) {
					notifications.warn(localize('appWindowScreenshot.shortcutConflict', 'The app window screenshot shortcut {0} is used by another application.', failure));
				}
				lastFailure = failure;
			}).catch(error => { if (!this.isDisposed) notifications.error(String(error)); });
		};
		const trigger = subscribe<unknown>(GLOBAL_KEYBINDING_TRIGGER_CHANNEL, event => {
			if (!event || typeof event !== 'object' || Object.keys(event).join(',') !== 'id' || !('id' in event)) {
				return;
			}
			if (event.id === lease.id) {
				void commands.executeCommand(lease.commandId).catch(error => notifications.error(String(error)));
			}
		});
		this._register(toDisposable(() => trigger.dispose()));
		this._register(keybindings.onDidUpdateKeybindings(syncShortcut));
		this._register(toDisposable(() => {
			void pending.then(() => invoke(GLOBAL_KEYBINDING_UPDATE_CHANNEL, { ...lease, accelerator: '', label: '', global: false })).catch(() => { });
		}));
		const update = (): void => {
			configured.set(configuration.getValue<boolean>(ChatConfiguration.AppWindowScreenshotsEnabled) === true);
			registration.clear();
			if (contextKeys.contextMatchesRules(enabled)) {
				registration.value = contexts.registerChatContextItem(instantiation.createInstance(AppWindowScreenshotContextValuePick));
			}
			syncShortcut();
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.AppWindowScreenshotsEnabled) || event.affectsConfiguration('chat.disableAIFeatures')) {
				update();
			}
		}));
		this._register(contextKeys.onDidChangeContext(event => { if (event.affectsSome(new Set([ChatContextKeys.enabled.key]))) update(); }));
		update();
	}
}
