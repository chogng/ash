import { createUuid } from '../../../../../base/common/uuid.js';
import { IImageEditorService } from '../../../../services/imageEditor/common/imageEditorService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ScreenshotCommandId } from '../../common/constants.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { EditorAction2 } from '../../../../../editor/browser/editorExtensions.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { withSelection } from '../../../../../platform/opener/common/opener.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { IView } from '../../../../common/views.js';
import { CHAT_VIEW_ID } from '../../common/chat.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatInstructionsPickerPick } from '../promptSyntax/attachInstructionsAction.js';
import { pickFiles } from '../../../../../base/browser/fileAccess.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	IChatContextPickService,
	isChatContextPickerPickItem,
	type ChatContextPick,
	type ChatContextPickAttachment,
	type IChatContextPickerItem,
	type IChatContextValueItem,
	type IChatContextPickerPickItem,
} from '../attachments/chatContextPickService.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { type AnythingQuickAccessProviderRunOptions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { SymbolsContextPickerPick, SearchViewResultChatContextPick } from '../../../search/browser/searchChatContext.js';
import { IChatAttachmentResolveService } from '../attachments/chatAttachmentResolveService.js';
import type { IAnythingQuickPickItem } from '../../../search/browser/anythingQuickAccess.js';
import {
	ClipboardImageContextValuePick,
	GitHubContextValuePick,
	ScreenshotContextValuePick,
	SessionReferenceContextPickerPick,
	TerminalContext,
	ToolsContextPickerPick,
} from './chatContext.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import type { ChatContextAttachment, ChatImageCapture, IChatContextTarget } from '../../../../services/chat/common/chatContextService.js';

/** Registers editor context commands for the lifetime of their Workbench host. */
export function registerChatContextActions(imageEditors: IImageEditorService, commands: ICommandService): DisposableStore {
	const store = new DisposableStore();
	store.add(imageEditors.registerAttachmentHandler(capture => commands.executeCommand(ScreenshotCommandId, capture)));
	store.add(registerAction2(class AttachSelectionToChatAction extends EditorAction2 {
		constructor() {
			super({
				id: 'workbench.action.chat.attachSelection',
				title: localize2('chat.context.addSelection', 'Add Selection to Chat'),
				f1: true,
				precondition: ContextKeyExpr.and(EditorContextKeys.hasNonEmptySelection.isEqualTo(true), ContextKeyExpr.notEquals(EditorContextKeys.languageId.key, 'ash-chat-input')),
				menu: { id: MenuId.EditorContext, group: 'z_chat', order: 1 },
				keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyL, weight: KeybindingWeight.WorkbenchContrib, when: EditorContextKeys.editorTextFocus.isEqualTo(true) },
			});
		}

		override async runEditorCommand(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
			const model = editor.getModel();
			const selection = editor.getSelection();
			if (!model || !selection || selection.isEmpty() || model.getLanguageId() === 'ash-chat-input') return;
			// Capture before opening Chat can change focus, the active editor, or its unsaved text.
			const code = model.getValueInRange(selection);
			const lastLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
			// Output URIs contain registry IDs; use the channel's presentation name in the composer.
			const channel = model.uri.scheme === 'output' ? accessor.get(IOutputService).getChannel(model.uri.path.slice(1)) : undefined;
			const sourceName = channel?.label ?? (model.getLanguageId() === 'debug-repl'
				? localize('chat.context.debugConsole', 'Debug Console')
				: basename(model.uri));
			const file = sourceName.replace(/\s/gu, ' ');
			const name = selection.startLineNumber === lastLine
				? localize('chat.context.selectionLine', '{0} ({1})', file, selection.startLineNumber)
				: localize('chat.context.selectionLines', '{0} ({1}-{2})', file, selection.startLineNumber, lastLine);
			const resource = withSelection(model.uri, selection);
			const content = `Source: ${resource.toString()}\n\n${code}`;
			const target = await accessor.get(IViewsService).openView<IView & IChatContextTarget>(CHAT_VIEW_ID);
			target?.addContext({ id: `code-selection:${createUuid()}`, kind: 'codeSelection', name, resource, resolve: async () => ({ name, content }) });
		}
	}));

	store.add(registerAction2(class CaptureScreenshotAction extends Action2 {
		constructor() {
			super({
				id: ScreenshotCommandId,
				// Keep the stored command ID so existing custom shortcuts still apply.
				title: localize2('chat.context.attachScreenshot', 'Screenshot: Capture Screen'),
				f1: true,
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyS,
					mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyA },
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}

		override async run(accessor: ServicesAccessor, capture?: ChatImageCapture): Promise<void> {
			if (capture !== undefined && typeof capture !== 'function') throw new TypeError('Expected a host-owned image capture');
			if (!capture) {
				await accessor.get(IImageEditorService).show({}, new AbortController().signal);
				return;
			}
			const target = await accessor.get(IViewsService).openView<IView & IChatContextTarget>(CHAT_VIEW_ID);
			await target?.captureScreenshot(capture);
		}
	}));

	return store;
}

interface AttachContextHost {
	readonly target: {
		attachFiles(files: readonly File[], signal?: AbortSignal): Promise<void>;
		acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal?: AbortSignal): Promise<readonly ChatContextAttachment[]>;
	};
	readonly container: HTMLElement;
	readonly focusInput: () => void;
	readonly supportsImages: () => boolean;
	readonly getDisabledTools?: () => Promise<readonly string[]>;
}

type ContextSourceItem = IQuickPickItem & (
	| { readonly source: 'upload' | 'workspace' | 'editors' | 'providers' | 'back'; }
	| { readonly source: 'context'; readonly context: IChatContextValueItem; }
);

/** Each picker belongs to its originating composer, even when another pane becomes active. */
export class AttachContextAction extends Disposable {
	private readonly pickers = this._register(new DisposableStore());
	private pending: AbortController | undefined;

	constructor(
		private readonly host: AttachContextHost,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatContextPickService private readonly contextPicks: IChatContextPickService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorGroupsService private readonly editors: IEditorGroupsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
		@IChatAttachmentResolveService private readonly attachmentResolver: IChatAttachmentResolveService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
	}

	public async run(anchor?: HTMLElement): Promise<void> {
		if (this.pending) { this.pending.abort(); return; }
		const controller = new AbortController();
		this.pending = controller;
		this.pickers.add(toDisposable(() => controller.abort()));
		anchor?.setAttribute('aria-expanded', 'true');
		// Child sources borrow the window's picker owner with this composer's placement.
		// Keeping the scope in DI covers multi-step sources without changing their attachment logic.
		const quickInput = this.quickInput;
		const contextBackground = { value: false };
		const createQuickPick = <T extends IQuickPickItem>(): IQuickPick<T> => {
			const picker = quickInput.createQuickPick<T>();
			picker.anchor = anchor;
			picker.anchorPosition = 'above';
			this.pickers.add(picker.onDidAccept(event => { contextBackground.value = event.inBackground; }));
			return picker;
		};
		const scopedQuickInput = new Proxy(quickInput, {
			get: (owner, key) => {
				if (key === 'createQuickPick') return createQuickPick;
				const value = Reflect.get(owner, key, owner);
				return typeof value === 'function' ? value.bind(owner) : value;
			},
		});
		const instantiation = this.pickers.add(this.instantiation.createChild(new ServiceCollection([IQuickInputService, scopedQuickInput])));
		try {
			const sources: ContextSourceItem[] = [{ label: localize('chat.attach.files', 'Attach files'), iconClass: ThemeIcon.asClassName(Lxicon.paperclip), source: 'upload' }];
			if (this.workspace.getWorkspace().folders.length) sources.unshift({ label: localize('chat.context.filesAndFolders', 'Files & Folders…'), iconClass: ThemeIcon.asClassName(Lxicon.folders), source: 'workspace' });
			const contexts: readonly IChatContextValueItem[] = [
				...(this.host.supportsImages() ? [instantiation.createInstance(ClipboardImageContextValuePick), instantiation.createInstance(ScreenshotContextValuePick)] : []),
				instantiation.createInstance(SessionReferenceContextPickerPick, this.navigation.getActiveConversation()),
				instantiation.createInstance(GitHubContextValuePick, 'issue'),
				instantiation.createInstance(GitHubContextValuePick, 'pullRequest'),
				instantiation.createInstance(TerminalContext),
				instantiation.createInstance(ToolsContextPickerPick, await raceCancellationError(Promise.resolve(this.host.getDisabledTools?.()), controller.signal) ?? []),
				instantiation.createInstance(SymbolsContextPickerPick),
				instantiation.createInstance(SearchViewResultChatContextPick),
				instantiation.createInstance(ChatInstructionsPickerPick, this.navigation.getActiveConversation()?.sessionId),
			];
			sources.push(...contexts.filter(context => context.isEnabled?.() !== false).map(context => ({ label: context.label, iconClass: ThemeIcon.asClassName(context.icon), source: 'context' as const, context })));
			if (this.editors.groups.some(group => group.inputs.length)) sources.push({ label: localize('chat.context.editors', 'Open editors'), iconClass: ThemeIcon.asClassName(Lxicon.files), source: 'editors' });
			const availableProviders = await raceCancellationError(Promise.all([...this.contextPicks.items].map(picker => picker.isEnabled?.() ?? true)), controller.signal);
			if (availableProviders.some(Boolean)) sources.push({ label: localize('chat.context.providers', 'Other context sources'), iconClass: ThemeIcon.asClassName(Lxicon.connectors), source: 'providers' });
			if (this.isDisposed || controller.signal.aborted) return;
			await this.showAttachments(sources, controller.signal, scopedQuickInput, contextBackground, anchor);
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted && !isCancellationError(error)) this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error)));
		} finally {
			this.pending = undefined;
			this.pickers.clear();
			anchor?.setAttribute('aria-expanded', 'false');
			// The shared picker first restores its trigger; the live composer owns the
			// final focus after success, cancellation, or failure.
			if (!this.isDisposed) this.host.focusInput();
		}
	}

	private showAttachments(sources: readonly ContextSourceItem[], signal: AbortSignal, quickInput: IQuickInputService, contextBackground: { value: boolean; }, anchor?: HTMLElement): Promise<void> {
		const lifetime = this.pickers.add(new DisposableStore());
		const ownedPicker = lifetime.add(new MutableDisposable());
		return new Promise((resolve, reject) => {
			let finished = false;
			let transitioning = false;
			let accepting = false;
			const finish = (error?: unknown): void => {
				if (finished) return;
				finished = true;
				if (error) reject(error); else resolve();
				lifetime.dispose();
			};
			lifetime.add(toDisposable(() => finish()));
			lifetime.add(addDisposableListener(signal, 'abort', () => finish()));
			const show = (folders = false): void => {
				if (finished || signal.aborted) return;
				transitioning = true;
				const additions: readonly ContextSourceItem[] = folders ? [{ label: localize('chat.context.goBack', 'Go back ↩'), iconClass: ThemeIcon.asClassName(Lxicon.arrowLeft), source: 'back', alwaysShow: true }] : sources.filter(item => item.source !== 'context' || item.context.isEnabled?.() !== false);
				const providerOptions: AnythingQuickAccessProviderRunOptions = {
					includeFolders: folders,
					additionPicks: additions,
					handleAccept: (item, background) => { void accept(item, background); },
				};
				this.quickInput.quickAccess.show('', {
					anchor,
					anchorPosition: 'above',
					placeholder: folders ? localize('chat.context.searchFilesAndFolders', 'Search file or folder by name') : localize('chat.context.searchAttachments', 'Search attachments'),
					enabledProviderPrefixes: [''],
					providerOptions,
				});
				const picker = this.quickInput.currentQuickInput;
				if (!picker) throw new Error('Quick Access did not create a picker');
				const resources = new DisposableStore();
				resources.add(toDisposable(() => picker.hide()));
				resources.add(picker.onDidHide(() => { if (!transitioning) finish(); }));
				ownedPicker.value = resources;
				transitioning = false;
			};
			const accept = async (item: IQuickPickItem, background: boolean): Promise<void> => {
				if (accepting || finished || signal.aborted) return;
				accepting = true;
				try {
					if ('source' in item) {
						if (item.source === 'workspace') { show(true); return; }
						if (item.source === 'back') { show(); return; }
						const picker = this.quickInput.currentQuickInput;
						transitioning = true;
						picker?.hide();
						if (item.source === 'context') {
							const context = (item as Extract<ContextSourceItem, { source: 'context'; }>).context;
							if ((context instanceof ClipboardImageContextValuePick || context instanceof ScreenshotContextValuePick) && !this.host.supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
							contextBackground.value = false;
							const attachments = await this.host.target.acquireContext(async draftSignal => {
								const selection = await context.asAttachment(undefined, AbortSignal.any([signal, draftSignal]));
								return selection ? Array.isArray(selection) ? selection : [selection] : [];
							}, signal);
							const attachment = attachments[0];
							if (finished || signal.aborted) return;
							if (attachment) {
								status(localize('chat.context.added', 'Added {0}', attachment.name));
							}
							if (context instanceof ScreenshotContextValuePick && !attachment) finish();
							else if (!attachment || background || contextBackground.value) show(); else finish();
							return;
						}
						if (item.source === 'upload') { await this.showFilePicker(signal); finish(); return; }
						if (item.source === 'providers') {
							contextBackground.value = false;
							const attachments = await this.host.target.acquireContext(async draftSignal => {
								const selection = await pickRegisteredChatContext(this.contextPicks, quickInput, this.commands, AbortSignal.any([signal, draftSignal]));
								const entries = !selection || selection === 'noop' ? [] : Array.isArray(selection) ? selection : [selection];
								if (entries.some(entry => entry.kind === 'image') && !this.host.supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
								return entries;
							}, signal);
							const attachment = attachments[0];
							if (attachment && !background && !contextBackground.value) finish(); else show();
							return;
						}
						const editors = [...new Map(this.editors.groups.flatMap(group => group.inputs).map(input => [extUri.getComparisonKey(input.resource), input])).values()];
						await this.host.target.acquireContext(async draftSignal => {
							const attachments = await Promise.all(editors.map(editor => this.attachmentResolver.resolveEditorAttachContext(editor, AbortSignal.any([signal, draftSignal]))));
							if (attachments.some(attachment => attachment?.kind === 'image') && !this.host.supportsImages()) {
								throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
							}
							return attachments.filter((attachment): attachment is ChatContextAttachment => attachment !== undefined);
						}, signal);
						finish();
						return;
					}
					const resource = item as IAnythingQuickPickItem;
					const attachments = await this.host.target.acquireContext(async draftSignal => {
						const attachment = await this.attachmentResolver.resolveResourceAttachContext(resource.resource, resource.kind === FileKind.Directory, AbortSignal.any([signal, draftSignal]));
						if (attachment.kind === 'image' && !this.host.supportsImages()) {
							throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
						}
						return [attachment];
					}, signal);
					const attachment = attachments[0];
					if (signal.aborted || finished || !attachment) return;
					status(localize('chat.context.added', 'Added {0}', attachment.name));
					if (!background) finish();
				} catch (error) {
					if (!signal.aborted) finish(error);
				} finally {
					accepting = false;
					transitioning = false;
				}
			};
			show();
		});
	}

	private async showFilePicker(signal: AbortSignal): Promise<void> {
		const files = await pickFiles({
			ownerDocument: this.host.container.ownerDocument,
			selection: 'multiple',
			ariaLabel: localize('chat.attach.files', 'Attach files'),
			signal,
		});
		if (files && !signal.aborted && !this.isDisposed) { await this.host.target.attachFiles(files, signal); }
	}

}


/** Selection is scoped to the originating composer; registration never owns a Quick Pick. */
async function pickRegisteredChatContext(service: IChatContextPickService, quickInput: IQuickInputService, commands: ICommandService, signal: AbortSignal): Promise<ChatContextPickAttachment | undefined> {
	const items = [...service.items];
	const available = await raceCancellationError(Promise.all(items.map(async item => await item.isEnabled?.() ?? true)), signal);
	const enabled = items.filter((item, index) => available[index] && [...service.items].includes(item));
	if (signal.aborted || enabled.length === 0) return undefined;
	const provider = enabled.length === 1 ? enabled[0] : await new Promise<IChatContextValueItem | IChatContextPickerItem | undefined>(resolve => {
		const resources = new DisposableStore();
		const picker = resources.add(quickInput.createQuickPick<IQuickPickItem & { provider: IChatContextValueItem | IChatContextPickerItem; }>());
		let done = false;
		const finish = (value: IChatContextValueItem | IChatContextPickerItem | undefined) => {
			if (done) return;
			done = true;
			resolve(value);
			resources.dispose();
		};
		picker.items = enabled.map(provider => ({ label: provider.label, iconClass: ThemeIcon.asClassName(provider.icon), provider }));
		picker.placeholder = localize('chat.context.selectSource', 'Select context source');
		picker.ariaLabel = picker.placeholder;
		picker.canAcceptInBackground = true;
		resources.add(picker.onDidAccept(() => finish(picker.selectedItems[0]?.provider)));
		resources.add(picker.onDidHide(() => finish(undefined)));
		resources.add(addDisposableListener(signal, 'abort', () => finish(undefined)));
		picker.show();
	});
	if (!provider || signal.aborted || ![...service.items].includes(provider)) return undefined;
	if (provider.type === 'valuePick') {
		const value = await raceCancellationError(provider.asAttachment(undefined, signal), signal);
		return [...service.items].includes(provider) ? value : undefined;
	}
	const context = provider.asPicker();
	const resources = new DisposableStore();
	const cancellation = new CancellationTokenSource();
	resources.add(toDisposable(() => cancellation.dispose(true)));
	resources.add(toDisposable(() => context.dispose?.()));
	const picker = resources.add(quickInput.createQuickPick<IChatContextPickerPickItem & { action?: 'back' | 'configure'; }>());
	picker.canAcceptInBackground = true;
	picker.sortByLabel = false;
	picker.filterValue = () => '';
	picker.placeholder = context.placeholder;
	picker.ariaLabel = context.placeholder;
	const query = observableValue('chatContextQuery', '');
	return new Promise<ChatContextPickAttachment | undefined>((resolve, reject) => {
		let done = false;
		let accepting = false;
		const finish = (value: ChatContextPickAttachment | undefined, error?: unknown) => {
			if (done) return;
			done = true;
			if (error) reject(error); else resolve(value);
			resources.dispose();
		};
		const current = () => !done && !signal.aborted && [...service.items].includes(provider);
		const render = (busy: boolean, picks: ChatContextPick[]) => {
			if (!current()) { finish(undefined); return; }
			picker.busy = busy;
			picker.items = busy ? [] : [
				...picks,
				{ label: localize('chat.context.goBack', 'Go back ↩'), action: 'back' as const, asAttachment: () => 'noop' as const },
				...(context.configure ? [{ label: context.configure.label, action: 'configure' as const, asAttachment: () => 'noop' as const }] : []),
			];
			if (busy) { picker.activeItems = []; picker.selectedItems = []; }
		};
		resources.add(picker.onDidChangeValue(value => query.set(value)));
		resources.add(picker.onDidHide(() => finish(undefined)));
		resources.add(addDisposableListener(signal, 'abort', () => finish(undefined)));
		resources.add(picker.onDidAccept(() => {
			if (!current()) { finish(undefined); return; }
			if (picker.busy || accepting) return;
			const item = picker.selectedItems[0];
			if (!isChatContextPickerPickItem(item) || item.disabled) return;
			if (item.action === 'back') { if (!context.goBack?.()) finish(undefined); return; }
			accepting = true;
			void Promise.resolve().then(() => {
				if (!current()) return undefined;
				return item.action === 'configure' ? commands.executeCommand(context.configure!.commandId).then(() => undefined) : item.asAttachment();
			}).then(value => finish(current() ? value : undefined), error => finish(undefined, error));
		}));
		picker.show();
		try {
			if (typeof context.picks === 'function') {
				const state = context.picks(query, cancellation.token);
				resources.add(autorun(reader => {
					const value = state.read(reader);
					if (value.error) finish(undefined, value.error);
					else render(value.busy, value.picks);
				}));
			} else {
				render(true, []);
				void context.picks.then(picks => render(false, picks), error => { if (current()) finish(undefined, error); });
			}
		} catch (error) {
			finish(undefined, error);
		}
	});
}
