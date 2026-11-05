import { addDisposableListener } from '../../../../base/browser/dom.js';
import { disposableWindowInterval } from '../../../../base/browser/scheduler.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { derived, observableFromEvent, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { ASH_CHAT_SELECTED_CONTEXT } from '../../chat/common/constants.js';
import type { ChatListEntry, ChatListProject, ChatListSnapshot, ChatListSource } from '../../chat/browser/chatListModel.js';
import { shareChatGPTConversation } from './chatGPTShare.js';
import type { ChatGPTConversation } from '../browser/chatGPTClient.js';
import { IChatGPTService, selectedChatConversationId, type ChatGPTState } from '../browser/chatGPTService.js';

const conversationIconPrefix = 'sessions.chatgpt.icon:';
const projectArchivePrefix = 'sessions.chatgpt.projectArchived:';

function conversationIconKey(id: string, scope: string | undefined): string | undefined {
	if (id.startsWith('local:')) return `${conversationIconPrefix}${id}`;
	if (scope && !id.startsWith('pending:')) return `${conversationIconPrefix}${scope}:${id}`;
	return undefined;
}

function projectArchiveKey(id: string, scope: string | undefined): string | undefined {
	return scope && `${projectArchivePrefix}${scope}:${id}`;
}

/** Projects ChatGPT's data into Ash's sidebar, including window selection and local row preferences. */
export class ChatGPTList extends Disposable implements ChatListSource {
	readonly snapshot;
	private readonly loadingStatus: ISessionStatusIcon = {
		label: localize('sessions.loadingConversation', 'Loading conversation…'),
		kind: 'inProgress',
		icon: Lxicon.sync,
	};
	private readonly replyingStatus: ISessionStatusIcon = {
		label: localize('sessions.chatgpt.replying', 'ChatGPT is replying…'),
		kind: 'inProgress',
		icon: Lxicon.sync,
	};
	private readonly workingStatus: ISessionStatusIcon = {
		label: localize('sessions.chat.coworkRunning', 'Cowork is working…'),
		kind: 'inProgress',
		icon: Lxicon.sync,
	};

	constructor(
		@IChatGPTService private readonly chat: IChatGPTService,
		@ICommandService private readonly commands: ICommandService,
		@IEditorService private readonly editors: IEditorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		const preferencesChanged = observableSignalFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE
				&& (event.key.startsWith(conversationIconPrefix) || event.key.startsWith(projectArchivePrefix))) listener(event);
		}));
		this._register(chat.onDidRetireConversationIdentity(({ id, replacementId }) => {
			const scope = chat.state.get().catalogScope;
			const key = conversationIconKey(id, scope);
			if (!key) return;
			if (replacementId) {
				const replacement = conversationIconKey(replacementId, scope);
				const icon = storage.get(key, StorageScope.PROFILE);
				if (!replacement || !icon) return;
				if (!storage.get(replacement, StorageScope.PROFILE)) {
					storage.store(replacement, icon, StorageScope.PROFILE, StorageTarget.MACHINE);
				}
			}
			storage.remove(key, StorageScope.PROFILE);
		}));
		const context = new Set([ASH_CHAT_SELECTED_CONTEXT]);
		const ashSelected = observableFromEvent(this,
			listener => contextKeys.onDidChangeContext(event => {
				if (event.affectsSome(context)) listener(event);
			}),
			() => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) === true);
		this.snapshot = derived<ChatListSnapshot>(reader => {
			const state = chat.state.read(reader);
			preferencesChanged.read(reader);
			const current = selectedChatConversationId(state);
			const showSelection = !ashSelected.read(reader);
			const coworkRunning = state.coworkTasks.some(task => {
				const status = task.thread?.turns.at(-1)?.status;
				return status === 'created' || status === 'running' || status === 'cancelling';
			});
			const projects = new Set(state.projects.map(project => project.id));
			const entries = state.conversations.map((conversation): ChatListEntry => {
				const { id, title, pinned, projectId } = conversation;
				const selected = id === current;
				const iconKey = conversationIconKey(id, state.catalogScope);
				return {
					id: `chatgpt:${id}`,
					title, pinned,
					// Custom GPT conversations also have gizmo IDs, but are not project members.
					projectId: projectId && (projectId.startsWith('g-p-') || projects.has(projectId)) ? projectId : undefined,
					selected: selected && showSelection,
					status: state.loading?.kind === 'conversation' && state.loading.id === id ? this.loadingStatus
						: selected && state.sending ? this.replyingStatus
							: selected && coworkRunning ? this.workingStatus : undefined,
					// Returning from Ash to the streaming conversation keeps the same ChatGPT selection.
					disabled: state.managing || state.sending && (showSelection || !selected),
					actionsDisabled: state.busy || state.sending,
					defaultIcon: id.startsWith('local:') ? Lxicon.cowork : Lxicon.chatSession,
					iconId: iconKey ? storage.get(iconKey, StorageScope.PROFILE) : undefined,
					setIcon: iconKey ? value => {
						const current = chat.state.get();
						if (conversationIconKey(id, current.catalogScope) !== iconKey || !current.conversations.some(item => item.id === id)
							|| value && !getLxiconDefinition(value.id)) return;
						storage.store(iconKey, value?.id, StorageScope.PROFILE, StorageTarget.MACHINE);
					} : undefined,
					open: signal => this.open(id, signal),
					setPinned: id.startsWith('pending:') ? undefined : pinned => chat.setPinned(id, pinned),
					getActions: (signal, restoreFocus) => this.getActions(conversation, signal, restoreFocus),
				};
			});
			return {
				entries,
				projects: state.projects.map(project => {
					const archiveKey = projectArchiveKey(project.id, state.catalogScope);
					const setArchived = archiveKey ? (archived: boolean) => {
						if (this.chat.state.get().catalogScope !== state.catalogScope) return;
						if (archived) storage.store(archiveKey, true, StorageScope.PROFILE, StorageTarget.MACHINE);
						else storage.remove(archiveKey, StorageScope.PROFILE);
					} : undefined;
					return {
						...project,
						history: this.projectHistory(project.id, state),
						archived: archiveKey ? storage.getBoolean(archiveKey, StorageScope.PROFILE, false) : undefined,
						restore: setArchived ? () => setArchived(false) : undefined,
						archive: setArchived ? () => setArchived(true) : undefined,
						remove: state.connected && state.networkAvailable && !state.managing
							? { removesContents: true, run: () => this.chat.deleteProject(project.id) } : undefined,
						editDetails: state.connected && state.networkAvailable
							? signal => this.chat.editProjectDetails(project.id, signal) : undefined,
					};
				}),
				loading: state.loading?.kind === 'history',
			};
		});
	}

	private projectHistory(projectId: string, state: ChatGPTState): ChatListProject['history'] {
		const page = state.projectHistory.get(projectId);
		if (page?.status === 'ready' && !page.cursor) return { state: 'complete' };
		if (!state.connected || !state.networkAvailable) return { state: 'unavailable' };
		if (!page) return { state: 'idle', load: () => this.chat.loadProjectConversations(projectId) };
		if (page.status === 'loading') return { state: 'loading' };
		return {
			state: page.status === 'error' ? 'error' : 'more',
			load: () => this.chat.loadProjectConversations(projectId, true),
		};
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): DisposableStore {
		const store = new DisposableStore();
		this.chat.setNetworkAvailable(window.navigator.onLine);
		this.chat.initialize();
		const refresh = (): void => {
			if (this.chat.state.get().pendingSync || window.document.visibilityState === 'visible' && isVisible()) {
				void this.chat.refresh();
			}
		};
		let blurred = false;
		store.add(addDisposableListener(window, 'blur', () => { blurred = true; }));
		store.add(addDisposableListener(window, 'focus', () => {
			if (!blurred) return;
			blurred = false;
			refresh();
		}));
		store.add(addDisposableListener(window, 'offline', () => this.chat.setNetworkAvailable(false)));
		store.add(addDisposableListener(window, 'online', () => { this.chat.setNetworkAvailable(true); refresh(); }));
		store.add(addDisposableListener(window.document, 'visibilitychange', refresh));
		store.add(disposableWindowInterval(window, refresh, 60_000));
		return store;
	}

	loadMore(retry: boolean): void {
		const state = this.chat.state.get();
		if (state.connected && !state.busy && !state.sending && !state.managing && state.hasMore && (retry || !state.error)) {
			void this.chat.loadMore();
		}
	}

	private async open(id: string, signal: AbortSignal): Promise<void> {
		await this.commands.executeCommand('sessions.show.chatgpt');
		if (signal.aborted) return;
		await this.chat.select(id);
		if (!signal.aborted) this.editors.focusActiveEditor();
	}

	private action(id: string, label: string, icon: IAction['icon'], run: () => unknown): IAction {
		return { id: `sessions.chatgpt.${id}`, label, tooltip: label, icon, enabled: true, run };
	}

	private async getActions(conversation: ChatGPTConversation, signal: AbortSignal, restoreFocus: () => void): Promise<readonly IAction[]> {
		const state = this.chat.state.get();
		const remove = { ...this.action('delete', localize('sessions.chatgpt.delete', 'Delete'), Lxicon.trash, () => this.deleteConversation(conversation)), class: 'ash-chat-navigation-delete-action' };
		if (conversation.id.startsWith('pending:') || !conversation.local && (!state.connected || !state.networkAvailable)) {
			return [remove];
		}
		const actions = [this.action('rename', localize('sessions.chatgpt.rename', 'Rename'), Lxicon.edit, async () => {
			await this.rename(conversation);
			restoreFocus();
		})];
		if (!conversation.local) {
			actions.push(new Separator(), this.action('share', localize('sessions.chatgpt.share', 'Share'), Lxicon.share, () => shareChatGPTConversation(this.chat, this.dialogs, this.clipboard, conversation.id, conversation.title)));
			let projects: readonly IAction[];
			try {
				const available = await this.chat.listProjects(signal);
				const scope = this.chat.state.get().catalogScope;
				projects = available.filter(project => {
					const key = projectArchiveKey(project.id, scope);
					return !key || !this.storage.getBoolean(key, StorageScope.PROFILE, false);
				}).map(project => ({
					...this.action(`move.${project.id}`, project.title, undefined, () => this.chat.moveToProject(conversation.id, project.id)),
					checked: project.id === conversation.projectId,
				}));
				if (!projects.length) {
					projects = [{ ...this.action('noProjects', localize('sessions.chatgpt.noProjects', 'No projects'), undefined, () => { }), enabled: false }];
				}
			} catch {
				projects = [{ ...this.action('projectsUnavailable', localize('sessions.chatgpt.projectsUnavailable', 'Could not load projects. Reopen the menu to retry.'), undefined, () => { }), enabled: false }];
			}
			actions.push(new SubmenuAction('sessions.chatgpt.moveToProject', localize('sessions.chatgpt.moveToProject', 'Move to project'), projects, Lxicon.folder));
		}
		actions.push(new Separator(), this.action('archive', localize('sessions.chatgpt.archive', 'Archive'), Lxicon.archive, () => this.chat.archive(conversation.id)), remove);
		return actions;
	}

	private async rename(conversation: ChatGPTConversation): Promise<void> {
		const title = await this.quickInput.input({
			title: localize('sessions.chatgpt.rename', 'Rename'), value: conversation.title,
			validateInput: async value => value.trim() && value.trim().length <= 256 ? undefined : localize('sessions.chatgpt.invalidTitle', 'Enter a name between 1 and 256 characters.'),
		});
		if (title !== undefined) { await this.chat.rename(conversation.id, title); }
	}

	private async deleteConversation(conversation: ChatGPTConversation): Promise<void> {
		const result = await this.dialogs.confirm({
			message: localize('sessions.chatgpt.deleteConfirm', 'Delete “{0}”?', conversation.title),
			detail: localize('sessions.chatgpt.deleteDetail', 'This chat will be permanently deleted.'),
			primaryButton: localize('sessions.chatgpt.delete', 'Delete'),
		});
		if (result.confirmed) { await this.chat.deleteConversation(conversation.id); }
	}

}
