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
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatContextPickService, type IChatContextTarget } from '../../../../services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickAccessController, type AnythingQuickAccessProviderRunOptions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { FilesAndFoldersPickerPick } from '../../../search/browser/searchChatContext.js';
import type { IAnythingQuickPickItem } from '../../../search/browser/anythingQuickAccess.js';
import { ClipboardImageContextValuePick, GitHubContextValuePick, ScreenshotContextValuePick, SessionReferenceContextPickerPick, type ChatContextSource } from './chatContext.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

interface AttachContextHost {
	readonly target: Pick<IChatContextTarget, 'addContext'>;
	readonly container: HTMLElement;
	readonly focusInput: () => void;
}

type ContextSourceItem = IQuickPickItem & (
	| { readonly source: 'upload' | 'workspace' | 'editors' | 'providers' | 'back'; }
	| { readonly source: 'context'; readonly context: ChatContextSource; }
);

/** Each picker belongs to its originating composer, even when another pane becomes active. */
export class AttachContextAction extends Disposable {
	private readonly pickers = this._register(new DisposableStore());
	private pending = false;

	constructor(
		private readonly host: AttachContextHost,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatContextPickService private readonly contextPicks: IChatContextPickService,
		@IQuickAccessController private readonly quickAccess: IQuickAccessController,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorGroupsService private readonly editors: IEditorGroupsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	public async run(): Promise<void> {
		if (this.pending) { return; }
		this.pending = true;
		const controller = new AbortController();
		this.pickers.add(toDisposable(() => controller.abort()));
		try {
			const sources: ContextSourceItem[] = [{ label: localize('chat.attach.files', 'Attach files'), iconClass: ThemeIcon.asClassName(Lxicon.paperclip), source: 'upload' }];
			if (this.workspace.getWorkspace().folders.length) sources.unshift({ label: localize('chat.context.filesAndFolders', 'Files & Folders…'), iconClass: ThemeIcon.asClassName(Lxicon.folders), source: 'workspace' });
			const contexts: readonly ChatContextSource[] = [
				this.instantiation.createInstance(ClipboardImageContextValuePick),
				this.instantiation.createInstance(ScreenshotContextValuePick),
				this.instantiation.createInstance(SessionReferenceContextPickerPick, this.navigation.getActiveConversation()),
				this.instantiation.createInstance(GitHubContextValuePick, 'issue'),
				this.instantiation.createInstance(GitHubContextValuePick, 'pullRequest'),
			];
			sources.push(...contexts.map(context => ({ label: context.label, iconClass: ThemeIcon.asClassName(context.icon), source: 'context' as const, context })));
			if (this.editors.groups.some(group => group.inputs.length)) sources.push({ label: localize('chat.context.editors', 'Open editors'), iconClass: ThemeIcon.asClassName(Lxicon.files), source: 'editors' });
			if ((await Promise.all(this.contextPicks.items.map(picker => picker.isEnabled()))).some(Boolean)) sources.push({ label: localize('chat.context.providers', 'Other context sources'), iconClass: ThemeIcon.asClassName(Lxicon.connectors), source: 'providers' });
			if (this.isDisposed) return;
			await this.showAttachments(sources, controller.signal);
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error)));
		} finally {
			this.pending = false;
			this.pickers.clear();
			if (!this.isDisposed) this.host.focusInput();
		}
	}

	private showAttachments(sources: readonly ContextSourceItem[], signal: AbortSignal): Promise<void> {
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
			const show = (folders = false): void => {
				if (finished || signal.aborted) return;
				transitioning = true;
				const additions: readonly ContextSourceItem[] = folders ? [{ label: localize('chat.context.goBack', 'Go back ↩'), iconClass: ThemeIcon.asClassName(Lxicon.arrowLeft), source: 'back', alwaysShow: true }] : sources;
				const providerOptions: AnythingQuickAccessProviderRunOptions = {
					includeFolders: folders,
					additionPicks: additions,
					handleAccept: (item, background) => { void accept(item, background); },
				};
				this.quickAccess.show('', {
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
							const attachment = await (item as Extract<ContextSourceItem, { source: 'context'; }>).context.asAttachment(signal);
							if (finished || signal.aborted) return;
							if (attachment) {
								this.host.target.addContext(attachment);
								status(localize('chat.context.added', 'Added {0}', attachment.name));
							}
							if (!attachment || background) show(); else finish();
							return;
						}
						if (item.source === 'upload') { await this.showFilePicker(); finish(); return; }
						if (item.source === 'providers') {
							const attachment = await this.contextPicks.pickContext(this.quickInput, signal);
							if (attachment && !signal.aborted) this.host.target.addContext(attachment);
							if (attachment) finish(); else show();
							return;
						}
						const editors = [...new Map(this.editors.groups.flatMap(group => group.inputs).map(input => [extUri.getComparisonKey(input.resource), input])).values()];
						const attachments = await Promise.all(editors.map(editor => resolver.asAttachment(editor.resource, FileKind.File, signal)));
						if (!signal.aborted) for (const attachment of attachments) this.host.target.addContext(attachment);
						finish();
						return;
					}
					const resource = item as IAnythingQuickPickItem;
					const attachment = await resolver.asAttachment(resource.resource, resource.kind, signal);
					if (signal.aborted || finished) return;
					this.host.target.addContext(attachment);
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

	private async showFilePicker(): Promise<void> {
		const controller = new AbortController();
		this.pickers.add(toDisposable(() => controller.abort()));
		const files = await pickFiles({
			ownerDocument: this.host.container.ownerDocument,
			selection: 'multiple',
			ariaLabel: localize('chat.attach.files', 'Attach files'),
			signal: controller.signal,
		});
		if (files && !this.isDisposed) { await this.attachFiles(files); }
	}

	private async attachFiles(files: readonly File[]): Promise<void> {
		try {
			const attachments = await Promise.all(files.map(async file => {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (!bytes.length) { throw new Error(localize('chat.attach.empty', '{0} is empty', file.name)); }
				const image = /^image\/(png|jpeg|gif|webp)$/u.test(file.type);
				let content: string;
				if (image) {
					let binary = '';
					for (let offset = 0; offset < bytes.length; offset += 8192) {
						binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
					}
					content = `data:${file.type};base64,${btoa(binary)}`;
				} else {
					try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
					catch { throw new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name)); }
					if (content.includes('\0') || !content.trim()) {
						throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', file.name));
					}
				}
				return { id: createUuid(), name: file.name, kind: image ? 'image' : 'file', resolve: async () => image ? { name: file.name, content, kind: 'image' as const } : { name: file.name, content } };
			}));
			if (!this.isDisposed) {
				for (const attachment of attachments) { this.host.target.addContext(attachment); }
				status(localize('chat.context.filesAdded', 'Added {0} attachments', attachments.length));
			}
		} catch (error) {
			if (!this.isDisposed) { this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error))); }
		}
	}

}
