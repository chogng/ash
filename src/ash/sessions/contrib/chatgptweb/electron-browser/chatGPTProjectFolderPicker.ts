import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ChatInputPickerActionViewItem } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { chatGPTAttachmentLimitMessage, chatGPTAttachmentLimits, IChatGPTService, isChatGPTNewDraft, type ChatGPTState } from '../browser/chatGPTService.js';

/** A Web draft can group the chat and choose an attachment source independently. */
export class ChatGPTProjectFolderPicker extends ChatInputPickerActionViewItem {
	private readonly operation = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		footer: HTMLElement,
		visible: IObservable<boolean>,
		@IChatGPTService private readonly chat: IChatGPTService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		const label = localize('sessions.chatgpt.projectOrFolder', 'Project or folder');
		super({
			id: 'sessions.chatgpt.projectOrFolder',
			get icon() {
				const state = chat.state.get();
				if (!state.draftTarget?.projectId && state.draftTarget?.folder) {
					return Lxicon.folder;
				}
				return Lxicon.projects;
			},
			get label() {
				const state = chat.state.get();
				const project = state.projects.find(item => item.id === state.draftTarget?.projectId);
				const folder = state.draftTarget?.folder;
				const name = folder && (basename(folder) || folder.fsPath);
				return project && name
					? localize('sessions.chatgpt.projectAndFolder', '{0} · {1}', project.title, name)
					: project?.title ?? name ?? label;
			},
			get tooltip() {
				return this.label === label ? label : localize('sessions.chatgpt.projectOrFolderSelected', 'Project or folder: {0}', this.label);
			},
			get enabled() { return canChoose(chat.state.get()); },
			run: () => this.show(),
		}, {
			actionProvider: { getActions: () => this.getActions() },
			buttonOptions: { size: 'small' },
			tabLeavesPopup: true,
			listOptions: {
				ariaLabel: label,
				showFilter: true,
				focusFilterOnOpen: true,
				filterPlaceholder: localize('sessions.chatgpt.searchProjectOrFolder', 'Search projects or folder actions'),
			},
		}, instantiation);
		const host = h(footer.ownerDocument, 'div', { className: 'ash-chat-input-workspace-slot' });
		footer.prepend(host);
		host.hidden = true;
		this._register(toDisposable(() => host.remove()));
		this.render(host);
		this.element.classList.add('ash-chat-input-workspace-picker');
		let identity: string | undefined;
		this._register(autorun(reader => {
			const state = chat.state.read(reader);
			const shown = visible.read(reader) && isChatGPTNewDraft(state);
			const current = shown ? `${state.localConversationId}:${chat.newDraftRevision}` : undefined;
			if (current !== identity || !canChoose(state)) {
				this.hide();
				this.operation.clear();
			}
			identity = current;
			host.hidden = !shown;
			if (!shown) return;
			this.updateEnabled();
			this.setTabbable(shown);
			this.refreshActionLabel();
		}));
	}

	private getActions(): readonly IAction[] {
		const state = this.chat.state.get();
		if (!canChoose(state)) return [];
		const revision = this.chat.newDraftRevision;
		const isCurrent = () => {
			const current = this.chat.state.get();
			return !this.isDisposed && !this.element.closest('[hidden]') && canChoose(current)
				&& current.localConversationId === state.localConversationId && this.chat.newDraftRevision === revision;
		};
		const choose = (change: Parameters<IChatGPTService['setDraftTarget']>[0]) => {
			if (!isCurrent()) return;
			this.chat.setDraftTarget(change);
			status(this.action.tooltip);
			this.focus();
		};
		const folder = state.draftTarget?.folder;
		const projects: IAction[] = state.projects.map(project => ({
			id: `project.${project.id}`, label: project.title, tooltip: project.title, icon: Lxicon.projects,
			enabled: true, checked: state.draftTarget?.projectId === project.id,
			run: () => choose({ projectId: project.id }),
		}));
		if (state.draftTarget?.projectId) {
			projects.push({
				id: 'project.clear', label: localize('sessions.chatgpt.clearProject', 'Clear project'),
				tooltip: '', enabled: true, run: () => choose({ projectId: undefined }),
			});
		}
		const folders: IAction[] = [{
			id: 'folder.choose', label: localize('sessions.chatgpt.chooseFolder', 'Choose folder…'),
			tooltip: folder?.fsPath ?? '', icon: Lxicon.folder, enabled: true,
			run: () => this.runFileAction(isCurrent, async (_cancellation, current) => {
				const [selected] = await this.dialogs.showOpenDialog({
					title: localize('sessions.chatgpt.chooseFolder', 'Choose folder…'),
					defaultUri: folder, canSelectFolders: true, canSelectFiles: false, availableFileSystems: ['file'],
				}) ?? [];
				if (selected && current()) choose({ folder: selected });
			}),
		}];
		if (folder) {
			folders.push({
				id: 'folder.attach', label: localize('sessions.chatgpt.attachFromFolder', 'Attach files from folder…'),
				tooltip: folder.fsPath, icon: Lxicon.add, enabled: state.connected && state.networkAvailable,
				run: () => this.runFileAction(isCurrent, (cancellation, current) => this.attachFromFolder(folder, cancellation, current)),
			}, {
				id: 'folder.clear', label: localize('sessions.chatgpt.clearFolder', 'Clear folder'),
				tooltip: '', enabled: true, run: () => choose({ folder: undefined }),
			});
		}
		return Separator.join(projects, folders);
	}

	private async runFileAction(isCurrent: () => boolean, run: (cancellation: CancellationTokenSource, current: () => boolean) => Promise<void>): Promise<void> {
		if (this.operation.value || !isCurrent()) return;
		this.focus();
		const operation = this.operation.value = new DisposableStore();
		const cancellation = new CancellationTokenSource();
		operation.add(toDisposable(() => cancellation.dispose(true)));
		const current = () => !cancellation.token.isCancellationRequested && isCurrent();
		try {
			await run(cancellation, current);
		} catch (error) {
			if (current()) this.notifications.error(error instanceof Error ? error : String(error));
		} finally {
			if (this.operation.value === operation) this.operation.clear();
		}
	}

	private async attachFromFolder(folder: URI, cancellation: CancellationTokenSource, isCurrent: () => boolean): Promise<void> {
		const resources = await this.dialogs.showOpenDialog({
			title: localize('sessions.chatgpt.attachFromFolder', 'Attach files from folder…'),
			defaultUri: folder, canSelectFolders: false, canSelectFiles: true, canSelectMany: true, availableFileSystems: ['file'],
		});
		if (!resources?.length || !isCurrent()) return;
		const state = this.chat.state.get();
		if (!state.connected || !state.networkAvailable || state.draftTarget?.folder !== folder) return;
		const attachments = state.attachments;
		const limits = chatGPTAttachmentLimits;
		if (attachments.length + resources.length > limits.count) throw new Error(chatGPTAttachmentLimitMessage());
		let remaining = limits.totalBytes - attachments.reduce((total, file) => total + file.size, 0);
		const files: File[] = [];
		for (const resource of resources) {
			if (!isCurrent() || resource.scheme !== 'file' || resource.authority) return;
			const name = basename(resource);
			try {
				const content = await this.files.readFileStream(resource, { limits: { size: Math.min(remaining, limits.fileBytes) } }, cancellation.token);
				const bytes = await streamToBuffer(content.value);
				remaining -= bytes.byteLength;
				files.push(new File([new Uint8Array(bytes.buffer)], name, { type: getMediaOrTextMime(name) }));
			} catch (error) {
				if (error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileTooLarge) {
					throw new Error(chatGPTAttachmentLimitMessage());
				}
				throw error;
			}
		}
		if (isCurrent() && this.chat.state.get().draftTarget?.folder === folder) await this.chat.attachFiles(files);
	}
}

function canChoose(state: ChatGPTState): boolean {
	return isChatGPTNewDraft(state) && !state.busy && !state.sending && !state.managing && !state.uncertain && state.voice === 'idle';
}
