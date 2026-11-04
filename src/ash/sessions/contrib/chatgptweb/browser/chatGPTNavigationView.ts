import { addDisposableListener } from '../../../../base/browser/dom.js';
import { disposableWindowInterval } from '../../../../base/browser/scheduler.js';
import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { derived, observableFromEvent } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { ASH_CHAT_SELECTED_CONTEXT } from '../../chat/common/constants.js';
import type { ChatNavigationEntry, ChatNavigationSnapshot, ChatNavigationSource } from '../../sessions/browser/views/chatNavigationView.js';
import { shareChatGPTConversation } from './chatGPTShare.js';
import type { ChatGPTConversation } from './chatGPTClient.js';
import { IChatGPTService, selectedChatConversationId } from './chatGPTService.js';

/** Projects ChatGPT history while the service retains account, history, and operation ownership. */
export class ChatGPTNavigationSource implements ChatNavigationSource {
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
	) {
		const context = new Set([ASH_CHAT_SELECTED_CONTEXT]);
		const ashSelected = observableFromEvent(this,
			listener => contextKeys.onDidChangeContext(event => {
				if (event.affectsSome(context)) listener(event);
			}),
			() => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) === true);
		this.snapshot = derived<ChatNavigationSnapshot>(reader => {
			const state = chat.state.read(reader);
			const current = selectedChatConversationId(state);
			const showSelection = !ashSelected.read(reader);
			const coworkRunning = state.coworkTasks.some(task => {
				const status = task.thread?.turns.at(-1)?.status;
				return status === 'created' || status === 'running' || status === 'cancelling';
			});
			const groups = [
				{ key: 'pinned', title: localize('sessions.chatgpt.pinnedGroup', 'Pinned'), rows: [] as ChatNavigationEntry[] },
				...state.projects.map(project => ({ key: project.id, title: project.title, rows: [] as ChatNavigationEntry[] })),
				{ key: 'other', title: localize('sessions.chatgpt.otherProjects', 'Other projects'), rows: [] as ChatNavigationEntry[] },
				{ key: 'recent', title: localize('sessions.chatgpt.recentGroup', 'Recent'), rows: [] as ChatNavigationEntry[] },
			];
			const buckets = new Map(groups.map(group => [group.key, group.rows]));
			const projects = new Set(state.projects.map(project => project.id));
			for (const conversation of state.conversations) {
				const { id, title, pinned, projectId } = conversation;
				const key = pinned ? 'pinned' : projectId && (projectId.startsWith('g-p-') || projects.has(projectId))
					? (projects.has(projectId) ? projectId : 'other') : 'recent';
				const selected = id === current;
				const icon = chat.observeConversationIcon(id);
				buckets.get(key)!.push({
					source: 'chatgpt',
					id, title, pinned,
					selected: selected && showSelection,
					status: state.loading?.kind === 'conversation' && state.loading.id === id ? this.loadingStatus
						: selected && state.sending ? this.replyingStatus
							: selected && coworkRunning ? this.workingStatus : undefined,
					// Returning from Ash to the streaming conversation keeps the same ChatGPT selection.
					disabled: state.managing || state.sending && (showSelection || !selected),
					actionsDisabled: state.busy || state.sending,
					defaultIcon: id.startsWith('local:') ? Lxicon.cowork : Lxicon.chat,
					iconId: icon?.read(reader),
					setIcon: icon && (value => chat.setConversationIcon(id, value?.id)),
					open: signal => this.open(id, signal),
					setPinned: id.startsWith('pending:') ? undefined : pinned => chat.setPinned(id, pinned),
					getActions: (signal, restoreFocus) => this.getActions(conversation, signal, restoreFocus),
				});
			}
			return { groups, loading: state.loading?.kind === 'history' };
		});
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

	private action(id: string, label: string, run: () => unknown): IAction {
		return { id: `sessions.chatgpt.${id}`, label, tooltip: label, enabled: true, run };
	}

	private async getActions(conversation: ChatGPTConversation, signal: AbortSignal, restoreFocus: () => void): Promise<readonly IAction[]> {
		const state = this.chat.state.get();
		const remove = this.action('delete', localize('sessions.chatgpt.delete', 'Delete'), () => this.deleteConversation(conversation));
		if (conversation.id.startsWith('pending:') || !conversation.local && (!state.connected || !state.networkAvailable)) {
			return [remove];
		}
		const actions = [this.action('rename', localize('sessions.chatgpt.rename', 'Rename'), async () => {
			await this.rename(conversation);
			restoreFocus();
		})];
		if (!conversation.local) actions.push(this.action('share', localize('sessions.chatgpt.share', 'Share'), () => shareChatGPTConversation(this.chat, this.dialogs, this.clipboard, conversation.id, conversation.title)));
		actions.push(this.action('archive', localize('sessions.chatgpt.archive', 'Archive'), () => this.chat.archive(conversation.id)), remove);
		if (!conversation.local) {
			let projects: readonly IAction[];
			try {
				projects = (await this.chat.listProjects(signal)).map(project => ({
					...this.action(`move.${project.id}`, project.title, () => this.chat.moveToProject(conversation.id, project.id)),
					checked: project.id === conversation.projectId,
				}));
				if (!projects.length) {
					projects = [{ ...this.action('noProjects', localize('sessions.chatgpt.noProjects', 'No projects'), () => { }), enabled: false }];
				}
			} catch {
				projects = [{ ...this.action('projectsUnavailable', localize('sessions.chatgpt.projectsUnavailable', 'Could not load projects. Reopen the menu to retry.'), () => { }), enabled: false }];
			}
			actions.push(new SubmenuAction('sessions.chatgpt.moveToProject', localize('sessions.chatgpt.moveToProject', 'Move to project'), projects));
		}
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
