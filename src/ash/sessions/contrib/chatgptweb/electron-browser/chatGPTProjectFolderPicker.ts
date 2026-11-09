import './chatGPTProjectFolderPicker.css';
import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon, getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
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
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { ChatInputPickerActionViewItem } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';
import { chatGPTAttachmentLimitMessage, chatGPTAttachmentLimits, chatGPTProjectPreferenceKey, IChatGPTService, isChatGPTNewDraft, type ChatGPTState } from '../browser/chatGPTService.js';

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
		@IProjectsService private readonly projects: IProjectsService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		const label = localize('sessions.chatgpt.projectOrFolder', 'Project or folder');
		super({
			id: 'sessions.chatgpt.projectOrFolder',
			get icon() {
				const state = chat.state.get();
				if (state.draftTarget?.projectId || state.draftTarget?.ashProjectId) {
					return undefined;
				}
				if (state.draftTarget?.folder) {
					return Lxicon.folder;
				}
				return Lxicon.projects;
			},
			get label() {
				const state = chat.state.get();
				const projectName = state.draftTarget?.ashProjectId
					? projects.state.get().projects.find(item => item.id === state.draftTarget?.ashProjectId)?.name
					: state.projects.find(item => item.id === state.draftTarget?.projectId)?.title;
				const folder = state.draftTarget?.folder;
				const name = folder && (basename(folder) || folder.fsPath);
				return projectName && name
					? localize('sessions.chatgpt.projectAndFolder', '{0} · {1}', projectName, name)
					: projectName ?? name ?? label;
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
				menuIconPlacement: 'leading-with-trailing-check',
				showFilter: true,
				focusFilterOnOpen: true,
				filterPlaceholder: localize('sessions.chatgpt.searchProjectOrFolder', 'Search'),
			},
		}, instantiation);
		const host = h(footer.ownerDocument, 'div', { className: 'ash-chat-input-workspace-slot ash-chatgpt-draft-target' });
		footer.prepend(host);
		host.hidden = true;
		this._register(toDisposable(() => host.remove()));
		this.render(host);
		this.element.classList.add('ash-chat-input-workspace-picker');
		const clearProject = localize('sessions.chatgpt.clearProject', 'Clear project');
		const remove = this._register(new Button(host, {
			label: '', ariaLabel: clearProject, title: clearProject, size: 'small',
			onClick: () => {
				if (!host.hidden && canChoose(chat.state.get())) {
					this.choose({ projectId: undefined, ashProjectId: undefined });
				}
			},
		}));
		remove.domNode.classList.add('ash-chatgpt-project-remove');
		const closeIcon = appendIcon(Lxicon.close, remove.domNode);
		let projectIcon: HTMLElement | undefined;
		host.prepend(remove.domNode);
		// The picker can open before the sidebar has mounted.
		const projectCatalog = projects.state.get();
		if (!projectCatalog.loading && !projectCatalog.projects.length) void projects.reload();
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
			const ashProject = projects.state.read(reader).projects.find(project => project.id === state.draftTarget?.ashProjectId);
			const projectId = state.draftTarget?.projectId;
			const hasProject = Boolean(projectId || state.draftTarget?.ashProjectId);
			host.classList.toggle('has-project', hasProject);
			remove.domNode.hidden = !hasProject;
			if (hasProject) {
				const key = projectId ? chatGPTProjectPreferenceKey(state.catalogScope, projectId) : undefined;
				const appearance = this.resolveAppearance(ashProject ?? (key ? projects.getCatalogProjectAppearance(key) : undefined));
				const icon = appearance.icon ?? Lxicon.projectsFilled;
				if (!projectIcon || projectIcon.dataset.ashIconId !== icon.id) {
					projectIcon?.remove();
					projectIcon = appendIcon(icon, remove.domNode);
					projectIcon.classList.add('ash-chatgpt-project-icon');
					closeIcon.before(projectIcon);
				}
				projectIcon.style.color = appearance.color ?? '';
			}
			remove.enabled = canChoose(state);
			this.updateEnabled();
			this.setTabbable(shown);
			this.refreshActionLabel();
		}));
	}

	getAttachMenuProjectActions(): readonly IAction[] | undefined {
		const state = this.chat.state.get();
		if (this.element.closest('[hidden]') || !canChoose(state)) return undefined;
		return this.getProjectActions(state, this.draftGuard(state));
	}

	private draftGuard(state: ChatGPTState): () => boolean {
		const revision = this.chat.newDraftRevision;
		return () => {
			const current = this.chat.state.get();
			return !this.isDisposed && !this.element.closest('[hidden]') && canChoose(current)
				&& current.localConversationId === state.localConversationId && this.chat.newDraftRevision === revision;
		};
	}

	private choose(change: Parameters<IChatGPTService['setDraftTarget']>[0]): void {
		this.chat.setDraftTarget(change);
		status(this.action.tooltip);
		this.focus();
	}

	private getProjectActions(state: ChatGPTState, isCurrent: () => boolean): IAction[] {
		const chatGPTProjects = state.projects.map(project => {
			const key = chatGPTProjectPreferenceKey(state.catalogScope, project.id);
			const appearance = this.resolveAppearance(key ? this.projects.getCatalogProjectAppearance(key) : undefined);
			return {
				id: `project.${project.id}`, label: project.title, tooltip: project.title,
				icon: appearance.icon ?? Lxicon.projects, iconColor: appearance.color,
				enabled: true, checked: state.draftTarget?.projectId === project.id,
				run: () => {
					if (isCurrent()) this.choose({ projectId: project.id });
				},
			};
		});
		const ashProjects = this.projects.state.get().projects.filter(project => !project.archived).map(project => {
			const appearance = this.resolveAppearance(project);
			return {
				id: `ash-project.${project.id}`, label: project.name, tooltip: project.name,
				icon: appearance.icon ?? Lxicon.projects, iconColor: appearance.color,
				enabled: true, checked: state.draftTarget?.ashProjectId === project.id,
				run: () => {
					if (isCurrent() && this.projects.state.get().projects.some(current => current.id === project.id && !current.archived)) {
						this.choose({ ashProjectId: project.id });
					}
				},
			};
		});
		return [...chatGPTProjects, ...ashProjects];
	}

	private resolveAppearance(appearance: { readonly icon?: string; readonly color?: string; } | undefined) {
		return {
			icon: appearance?.icon ? getRegisteredIcon(appearance.icon, this.element.ownerDocument) : undefined,
			color: appearance?.color ? `var(${colorCssVariable(appearance.color)})` : undefined,
		};
	}

	private getActions(): readonly IAction[] {
		const state = this.chat.state.get();
		if (!canChoose(state)) return [];
		const isCurrent = this.draftGuard(state);
		const choose = (change: Parameters<IChatGPTService['setDraftTarget']>[0]) => {
			if (isCurrent()) this.choose(change);
		};
		const projects = this.getProjectActions(state, isCurrent);
		const folder = state.draftTarget?.folder;
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
