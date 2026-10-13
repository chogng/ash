import { ChatInstructionsPickerPick } from '../promptSyntax/attachInstructionsAction.js';
import { createImageAttachment } from '../chatImageUtils.js';
import { pickFiles } from '../../../../../base/browser/fileAccess.js';
import { createUuid } from '../../../../../base/common/uuid.js';
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
import { IChatContextPickService, type IChatContextTarget } from '../../../../services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { type AnythingQuickAccessProviderRunOptions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { FilesAndFoldersPickerPick, SymbolsContextPickerPick, SearchViewResultChatContextPick } from '../../../search/browser/searchChatContext.js';
import type { IAnythingQuickPickItem } from '../../../search/browser/anythingQuickAccess.js';
import { ClipboardImageContextValuePick, GitHubContextValuePick, ScreenshotContextValuePick, SessionReferenceContextPickerPick, TerminalContext, ToolsContextPickerPick, type ChatContextSource } from './chatContext.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';

interface AttachContextHost {
	readonly target: Pick<IChatContextTarget, 'addContext'>;
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
		let added = false;
		let failed = false;
		let completed = false;
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
		const addContext = (attachment: Parameters<IChatContextTarget['addContext']>[0]): void => {
			this.host.target.addContext(attachment);
			added = true;
		};
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
			completed = await this.showAttachments(sources, controller.signal, scopedQuickInput, addContext, anchor);
		} catch (error) {
			failed = true;
			if (!this.isDisposed && !controller.signal.aborted) this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error)));
		} finally {
			this.pending = undefined;
			this.pickers.clear();
			anchor?.setAttribute('aria-expanded', 'false');
			if (!this.isDisposed && ((added && completed) || failed)) this.host.focusInput();
		}
	}

	private showAttachments(sources: readonly ContextSourceItem[], signal: AbortSignal, quickInput: IQuickInputService, addContext: IChatContextTarget['addContext'], anchor?: HTMLElement): Promise<boolean> {
		const lifetime = this.pickers.add(new DisposableStore());
		const ownedPicker = lifetime.add(new MutableDisposable());
		const resolver = this.instantiation.createInstance(FilesAndFoldersPickerPick);
		return new Promise((resolve, reject) => {
			let finished = false;
			let transitioning = false;
			let accepting = false;
			const finish = (error?: unknown, accepted = false): void => {
				if (finished) return;
				finished = true;
				if (error) reject(error); else resolve(accepted);
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
							const selection = await context.asAttachment(signal);
							const attachment = selection?.attachment;
							if (finished || signal.aborted) return;
							if (attachment) {
								addContext(attachment);
								status(localize('chat.context.added', 'Added {0}', attachment.name));
							}
							if (!attachment || background || selection?.acceptInBackground) show(); else finish(undefined, true);
							return;
						}
						if (item.source === 'upload') { await this.showFilePicker(addContext, signal); finish(undefined, true); return; }
						if (item.source === 'providers') {
							const attachment = await this.contextPicks.pickContext(quickInput, signal);
							if (attachment && !signal.aborted) addContext(attachment);
							if (attachment) finish(undefined, true); else show();
							return;
						}
						const editors = [...new Map(this.editors.groups.flatMap(group => group.inputs).map(input => [extUri.getComparisonKey(input.resource), input])).values()];
						const attachments = await Promise.all(editors.map(editor => resolver.asAttachment(editor.resource, FileKind.File, signal)));
						if (!signal.aborted) for (const attachment of attachments) addContext(attachment);
						finish(undefined, true);
						return;
					}
					const resource = item as IAnythingQuickPickItem;
					const attachment = await resolver.asAttachment(resource.resource, resource.kind, signal);
					if (signal.aborted || finished) return;
					addContext(attachment);
					status(localize('chat.context.added', 'Added {0}', attachment.name));
					if (!background) finish(undefined, true);
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

	private async showFilePicker(addContext: IChatContextTarget['addContext'], signal: AbortSignal): Promise<void> {
		const files = await pickFiles({
			ownerDocument: this.host.container.ownerDocument,
			selection: 'multiple',
			ariaLabel: localize('chat.attach.files', 'Attach files'),
			signal,
		});
		if (files && !signal.aborted && !this.isDisposed) { await this.attachFiles(files, addContext, signal); }
	}

	private async attachFiles(files: readonly File[], addContext: IChatContextTarget['addContext'], signal: AbortSignal): Promise<void> {
		try {
			const attachments = await Promise.all(files.map(async file => {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (!bytes.length) { throw new Error(localize('chat.attach.empty', '{0} is empty', file.name)); }
				const image = /^image\/(png|jpeg|gif|webp)$/u.test(file.type);
				let content: string;
				if (image) {
					if (!this.host.supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
					return createImageAttachment(file.name, bytes, file.type);
				} else {
					try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
					catch { throw new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name)); }
					if (content.includes('\0') || !content.trim()) {
						throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', file.name));
					}
				}
				return { id: createUuid(), name: file.name, kind: 'file', resolve: async () => ({ name: file.name, content }) };
			}));
			if (!this.isDisposed && !signal.aborted) {
				for (const attachment of attachments) { addContext(attachment); }
				status(localize('chat.context.filesAdded', 'Added {0} attachments', attachments.length));
			}
		} catch (error) {
			if (!this.isDisposed && !signal.aborted) { this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error))); }
		}
	}

}
