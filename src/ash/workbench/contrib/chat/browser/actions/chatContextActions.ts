import { ChatInstructionsPickerPick } from '../promptSyntax/attachInstructionsAction.js';
import { pickFiles } from '../../../../../base/browser/fileAccess.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatContextPickService } from '../../../../services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { type AnythingQuickAccessProviderRunOptions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { FilesAndFoldersPickerPick, SymbolsContextPickerPick, SearchViewResultChatContextPick } from '../../../search/browser/searchChatContext.js';
import type { IAnythingQuickPickItem } from '../../../search/browser/anythingQuickAccess.js';
import { ClipboardImageContextValuePick, GitHubContextValuePick, ScreenshotContextValuePick, SessionReferenceContextPickerPick, TerminalContext, ToolsContextPickerPick, type ChatContextSource } from './chatContext.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

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
	| { readonly source: 'context'; readonly context: ChatContextSource; }
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
		const createQuickPick = <T extends IQuickPickItem>(): IQuickPick<T> => {
			const picker = quickInput.createQuickPick<T>();
			picker.anchor = anchor;
			picker.anchorPosition = 'above';
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
			const contexts: readonly ChatContextSource[] = [
				...(this.host.supportsImages() ? [instantiation.createInstance(ClipboardImageContextValuePick), instantiation.createInstance(ScreenshotContextValuePick)] : []),
				instantiation.createInstance(SessionReferenceContextPickerPick, this.navigation.getActiveConversation()),
				instantiation.createInstance(GitHubContextValuePick, 'issue'),
				instantiation.createInstance(GitHubContextValuePick, 'pullRequest'),
				instantiation.createInstance(TerminalContext),
				instantiation.createInstance(ToolsContextPickerPick, await this.host.getDisabledTools?.() ?? []),
				instantiation.createInstance(SymbolsContextPickerPick),
				instantiation.createInstance(SearchViewResultChatContextPick),
				instantiation.createInstance(ChatInstructionsPickerPick, this.navigation.getActiveConversation()?.sessionId),
			];
			sources.push(...contexts.filter(context => context.isEnabled?.() !== false).map(context => ({ label: context.label, iconClass: ThemeIcon.asClassName(context.icon), source: 'context' as const, context })));
			if (this.editors.groups.some(group => group.inputs.length)) sources.push({ label: localize('chat.context.editors', 'Open editors'), iconClass: ThemeIcon.asClassName(Lxicon.files), source: 'editors' });
			if ((await Promise.all(this.contextPicks.items.map(picker => picker.isEnabled()))).some(Boolean)) sources.push({ label: localize('chat.context.providers', 'Other context sources'), iconClass: ThemeIcon.asClassName(Lxicon.connectors), source: 'providers' });
			if (this.isDisposed || controller.signal.aborted) return;
			await this.showAttachments(sources, controller.signal, scopedQuickInput, anchor);
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

	private showAttachments(sources: readonly ContextSourceItem[], signal: AbortSignal, quickInput: IQuickInputService, anchor?: HTMLElement): Promise<void> {
		const lifetime = this.pickers.add(new DisposableStore());
		const ownedPicker = lifetime.add(new MutableDisposable());
		const resolver = this.instantiation.createInstance(FilesAndFoldersPickerPick);
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
							let selection: Awaited<ReturnType<ChatContextSource['asAttachment']>>;
							const attachments = await this.host.target.acquireContext(async draftSignal => {
								selection = await context.asAttachment(AbortSignal.any([signal, draftSignal]));
								return selection ? [selection.attachment] : [];
							}, signal);
							const attachment = attachments[0];
							if (finished || signal.aborted) return;
							if (attachment) {
								status(localize('chat.context.added', 'Added {0}', attachment.name));
							}
							if (!attachment || background || selection?.acceptInBackground) show(); else finish();
							return;
						}
						if (item.source === 'upload') { await this.showFilePicker(signal); finish(); return; }
						if (item.source === 'providers') {
							const attachments = await this.host.target.acquireContext(async draftSignal => {
								const attachment = await this.contextPicks.pickContext(quickInput, AbortSignal.any([signal, draftSignal]));
								return attachment ? [attachment] : [];
							}, signal);
							const attachment = attachments[0];
							if (attachment) finish(); else show();
							return;
						}
						const editors = [...new Map(this.editors.groups.flatMap(group => group.inputs).map(input => [extUri.getComparisonKey(input.resource), input])).values()];
						await this.host.target.acquireContext(draftSignal => Promise.all(editors.map(editor => resolver.asAttachment(editor.resource, FileKind.File, AbortSignal.any([signal, draftSignal])))), signal);
						finish();
						return;
					}
					const resource = item as IAnythingQuickPickItem;
					const attachments = await this.host.target.acquireContext(async draftSignal => [await resolver.asAttachment(resource.resource, resource.kind, AbortSignal.any([signal, draftSignal]))], signal);
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
