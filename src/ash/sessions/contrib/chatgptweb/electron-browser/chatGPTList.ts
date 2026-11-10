import { addDisposableListener } from '../../../../base/browser/dom.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { disposableWindowInterval, disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { autorun, derived, observableFromEvent, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { SHOW_EXPERIMENTAL_CHATGPT } from '../common/chatGPTNative.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_LAST_BACKEND_KEY } from '../../chat/common/constants.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import type { CatalogProjectDetails, ChatListEntry, ChatListProject, ChatListSnapshot, ChatListSource } from '../../chat/browser/chatListModel.js';
import { shareChatGPTConversation } from './chatGPTShare.js';
import { ChatGPTProjectDraftModel } from './chatGPTProjectDraftModel.js';
import { chatGPTAttachmentLimitMessage, chatGPTAttachmentLimits, chatGPTProjectConversationId, chatGPTProjectPreferenceKey, IChatGPTNativeService, IChatGPTService, selectedChatConversationId, type ChatGPTState } from '../browser/chatGPTService.js';

const projectArchivePrefix = 'sessions.chatgpt.projectArchived:';

function conversationPreferenceKey(id: string, scope: string | undefined): string | undefined {
	if (id.startsWith('local:')) return id;
	if (scope && !id.startsWith('pending:')) return `${scope}:${id}`;
	return undefined;
}

function projectArchiveKey(id: string, scope: string | undefined): string | undefined {
	return scope && `${projectArchivePrefix}${scope}:${id}`;
}

/** Projects ChatGPT's data into Ash's sidebar, including window selection and scoped preference identities. */
export class ChatGPTList extends Disposable implements ChatListSource {
	readonly snapshot;
	private readonly retiredPreferences = this._register(new Emitter<{ readonly key: string; readonly replacementKey?: string; }>());
	readonly onDidRetirePreferenceIdentity = this.retiredPreferences.event;
	private readonly nativeSelected;
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
		@IFileService private readonly files: IFileService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const preferencesChanged = observableSignalFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(projectArchivePrefix)) listener(event);
		}));
		this._register(chat.onDidRetireConversationIdentity(({ id, replacementId }) => {
			const scope = chat.state.get().catalogScope;
			const key = conversationPreferenceKey(id, scope);
			const replacementKey = replacementId && conversationPreferenceKey(replacementId, scope);
			if (key && (!replacementId || replacementKey)) this.retiredPreferences.fire({ key, replacementKey });
		}));
		// The provider catalog stays visible when the user leaves its editor for Code.
		this.nativeSelected = observableFromEvent(this,
			listener => storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.WORKSPACE && event.key === CHAT_WORKSPACE_LAST_BACKEND_KEY) listener(event);
			}),
			() => storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE) === 'chatgpt-native');
		this._register(autorun(reader => {
			chat.setHistoryNotificationsVisible?.(this.nativeSelected.read(reader) === !!chat.native);
		}));
		const context = new Set([ASH_CHAT_SELECTED_CONTEXT, SessionsWorkspaceModeContext.key]);
		const chatSelected = observableFromEvent(this,
			listener => contextKeys.onDidChangeContext(event => {
				if (event.affectsSome(context)) listener(event);
			}),
			() => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) !== true
				&& contextKeys.getValue(SessionsWorkspaceModeContext.key) !== 'code');
		this.snapshot = derived<ChatListSnapshot>(reader => {
			if (this.nativeSelected.read(reader) !== !!chat.native) return { entries: [] };
			const state = chat.state.read(reader);
			preferencesChanged.read(reader);
			const current = selectedChatConversationId(state);
			const showSelection = chatSelected.read(reader);
			const coworkRunning = state.coworkTasks.some(task => {
				const status = task.thread?.turns.at(-1)?.status;
				return status === 'created' || status === 'running' || status === 'cancelling';
			});
			const projects = new Set(state.projects.map(project => project.id));
			const visibleProjects = (available: typeof state.projects) => available.filter(project => {
				const key = projectArchiveKey(project.id, state.catalogScope);
				return !key || !this.storage.getBoolean(key, StorageScope.PROFILE, false);
			});
			const destinations = visibleProjects(state.projects).map(({ id, title }) => ({ id, title }));
			const currentAccount = () => chat.state.get().catalogScope === state.catalogScope;
			const entries = state.conversations.map((conversation): ChatListEntry => {
				const { id, title, pinned, projectId } = conversation;
				const selected = id === current;
				// Custom GPT conversations also have gizmo IDs, but are not project members.
				const currentProject = projectId && (projectId.startsWith('g-p-') || projects.has(projectId)) ? projectId : undefined;
				const catalogId = this.conversationCatalogId(id);
				const canManage = !id.startsWith('pending:') && (conversation.local || state.connected && state.networkAvailable);
				const rename = canManage ? async (name: string) => {
					if (currentAccount()) await chat.rename(id, name);
				} : undefined;
				const share = canManage && !conversation.local ? async () => {
					if (currentAccount()) await shareChatGPTConversation(chat, this.dialogs, this.clipboard, id, title);
				} : undefined;
				return {
					id: catalogId,
					externalConversationId: conversation.local || id.startsWith('pending:') ? undefined : chatGPTProjectConversationId(state.catalogScope, id),
					title, pinned,
					createdAt: conversation.createdAt,
					updatedAt: conversation.updatedAt,
					projectId: currentProject,
					selected: selected && showSelection,
					status: state.loading?.kind === 'conversation' && state.loading.id === id ? this.loadingStatus
						: selected && state.sending ? this.replyingStatus
							: selected && coworkRunning ? this.workingStatus : undefined,
					// Returning from Ash to the streaming conversation keeps the same ChatGPT selection.
					disabled: state.managing || state.sending && (showSelection || !selected),
					actionsDisabled: state.busy || state.sending,
					defaultIcon: id.startsWith('local:') ? Lxicon.cowork : Lxicon.chatSession,
					preferenceKey: conversationPreferenceKey(id, state.catalogScope),
					open: signal => this.open(id, signal),
					rename, share,
					remove: async () => { if (currentAccount()) await chat.deleteConversation(id); },
					archive: canManage ? async () => currentAccount() && await chat.archive(id) : undefined,
					setPinned: !id.startsWith('pending:') ? async pinned => { if (currentAccount()) await chat.setPinned(id, pinned); } : undefined,
					project: !conversation.local && !id.startsWith('pending:') && (!projectId || currentProject) && state.connected && state.networkAvailable ? {
						current: currentProject,
						destinations,
						createAndMove: async name => {
							if (state.catalogScope !== this.chat.state.get().catalogScope) throw new CancellationError();
							await this.chat.createProjectAndMove(id, name);
						},
						move: async destination => {
							if (state.catalogScope !== this.chat.state.get().catalogScope) {
								throw new Error(localize('sessions.chatgpt.projectMoveFailed', 'Could not move this conversation. Try again.'));
							}
							await this.chat.moveToProject(id, destination ?? null);
						},
					} : undefined,
					getActions: (_signal, restoreFocus) => this.getActions(title, rename, share, restoreFocus),
				};
			});
			return {
				entries,
				projects: state.projects.map((project): ChatListProject => {
					const scope = state.catalogScope;
					const online = state.connected && state.networkAvailable;
					const isCurrentAccount = () => this.chat.state.get().catalogScope === state.catalogScope;
					const archiveKey = projectArchiveKey(project.id, state.catalogScope);
					const setArchived = archiveKey ? (archived: boolean) => {
						if (!isCurrentAccount()) return;
						if (archived) storage.store(archiveKey, true, StorageScope.PROFILE, StorageTarget.MACHINE);
						else storage.remove(archiveKey, StorageScope.PROFILE);
					} : undefined;
					return {
						id: project.id,
						title: project.title,
						createdAt: project.createdAt,
						updatedAt: project.updatedAt,
						history: this.projectHistory(project.id, state),
						details: scope ? this.projectDetails(project.id, scope, online) : undefined,
						composer: scope ? {
							key: JSON.stringify([chat.native === true, scope, project.id]),
							create: isVisible => instantiation.createInstance(ChatGPTProjectDraftModel, project.id, scope, isVisible,
								(id: string, signal: AbortSignal) => this.open(id, signal)),
						} : undefined,
						preferenceKey: chatGPTProjectPreferenceKey(state.catalogScope, project.id),
						archived: archiveKey ? storage.getBoolean(archiveKey, StorageScope.PROFILE, false) : undefined,
						restore: setArchived ? () => setArchived(false) : undefined,
						archive: setArchived && state.connected && state.networkAvailable && !state.busy && !state.sending && !state.managing && state.voice === 'idle'
							? async () => {
								if (!isCurrentAccount() || !await this.chat.archiveProjectConversations(project.id) || !isCurrentAccount()) return false;
								setArchived(true);
								return true;
							} : undefined,
						remove: state.connected && state.networkAvailable && !state.managing
							? { removesContents: true, run: async () => { if (isCurrentAccount()) await this.chat.deleteProject(project.id); } } : undefined,
						editDetails: state.connected && state.networkAvailable
							? async signal => {
								if (!isCurrentAccount()) throw new CancellationError();
								return this.chat.editProjectDetails(project.id, signal);
							} : undefined,
					};
				}),
				loading: state.loading?.kind === 'history',
			};
		});
	}

	private projectDetails(id: string, scope: string, online: boolean): CatalogProjectDetails {
		return {
			key: JSON.stringify([this.chat.native === true, scope, id]),
			load: online ? signal => this.chat.loadProjectDetails(id, scope, signal) : undefined,
			data: this.chat.projectDetails.map(values => {
				const details = values.get(id);
				if (!details) return undefined;
				const canEdit = online && details.canWrite === true;
				return {
					description: details.description,
					canEdit,
					materials: details.files?.map(file => ({
						...file, kind: 'file' as const,
						download: online ? (target: URI) => this.downloadProjectFile(id, scope, file.id, target) : undefined,
						remove: canEdit ? () => this.chat.removeProjectFile(id, scope, file.id) : undefined,
					})),
				};
			}),
			addFiles: online ? resources => this.addProjectFiles(id, scope, resources) : undefined,
		};
	}

	private async addProjectFiles(id: string, scope: string, resources: readonly URI[]): Promise<void> {
		const limits = chatGPTAttachmentLimits;
		if (resources.length > limits.count) throw new Error(chatGPTAttachmentLimitMessage());
		const files: File[] = [];
		let total = 0;
		for (const resource of resources) {
			if (resource.scheme !== 'file' || resource.authority || this.chat.state.get().catalogScope !== scope) throw new CancellationError();
			const name = basename(resource);
			const content = await this.files.readFileStream(resource, { limits: { size: Math.min(limits.fileBytes, limits.totalBytes - total) } });
			const bytes = await streamToBuffer(content.value);
			total += bytes.byteLength;
			files.push(new File([new Uint8Array(bytes.buffer)], name, { type: getMediaOrTextMime(name), lastModified: content.modifiedAtMillis }));
		}
		await this.chat.addProjectFiles(id, scope, files);
	}

	private async downloadProjectFile(id: string, scope: string, fileId: string, target: URI): Promise<void> {
		const blob = await this.chat.readProjectFile(id, scope, fileId);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		if (this.chat.state.get().catalogScope !== scope) return;
		await this.files.writeFileBytes(target, bytes, { create: true, overwrite: true });
	}

	private projectHistory(projectId: string, state: ChatGPTState): ChatListProject['history'] {
		const page = state.projectHistory.get(projectId);
		if (page?.status === 'ready' && !page.cursor) return { state: 'complete' };
		if (!state.connected || !state.networkAvailable) return { state: 'unavailable' };
		if (!page) return { state: 'idle', load: () => this.chat.loadProjectConversations(projectId) };
		if (page.status === 'loading') return { state: 'loading' };
		if (page.status === 'error') return { state: 'error' };
		return { state: 'more', load: () => this.chat.loadProjectConversations(projectId, true) };
	}

	archiveProjectMembers(references: ReadonlySet<string>): Promise<ReadonlySet<string>> {
		return this.chat.archiveProjectMembers(references);
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): DisposableStore {
		const store = new DisposableStore();
		const reconnect = store.add(new MutableDisposable());
		const active = () => this.nativeSelected.get() === !!this.chat.native;
		const retainedBackend = this.storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE);
		const restoreCatalog = retainedBackend === (this.chat.native ? 'chatgpt-native' : 'chatgpt');
		if (!this.chat.native || restoreCatalog) {
			this.chat.setNetworkAvailable(window.navigator.onLine);
		}
		// Pages such as Projects restore the shared sidebar without opening a chat editor.
		// The retained backend still owns its account-scoped catalog and selection.
		if (restoreCatalog) this.chat.initialize();
		const refresh = (): void => {
			if (this.chat.state.get().pendingSync || active() && window.document.visibilityState === 'visible' && isVisible()) {
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
		store.add(addDisposableListener(window, 'offline', () => {
			reconnect.clear();
			if (!this.chat.native || active() || this.chat.state.get().pendingSync) this.chat.setNetworkAvailable(false);
		}));
		store.add(addDisposableListener(window, 'online', () => {
			if (!active() && !this.chat.state.get().pendingSync) return;
			if (this.chat.state.get().networkAvailable) { refresh(); return; }
			if (reconnect.value) { return; }
			// Wait for a stable reconnect before enabling history reads across the window.
			reconnect.value = disposableWindowTimeout(window, () => {
				reconnect.clear();
				if (!active() && !this.chat.state.get().pendingSync) return;
				const { connected, catalogScope } = this.chat.state.get();
				this.chat.setNetworkAvailable(true);
				if (!connected && !catalogScope) { this.chat.initialize(); }
				else { refresh(); }
			}, 1000);
		}));
		store.add(addDisposableListener(window.document, 'visibilitychange', refresh));
		if (!this.chat.native) {
			store.add(disposableWindowInterval(window, () => {
				if (this.chat.state.get().pendingSync) { refresh(); }
			}, 60_000));
		}
		return store;
	}

	loadMore(): void {
		if (this.nativeSelected.get() !== !!this.chat.native) return;
		const state = this.chat.state.get();
		if (state.connected && state.networkAvailable && !state.busy && !state.sending && !state.managing && state.hasMore && !state.error && !state.historyListFailed) {
			void this.chat.loadMore();
		}
	}

	private async open(id: string, signal: AbortSignal): Promise<void> {
		const opened = await this.commands.executeCommand(this.chat.native ? SHOW_EXPERIMENTAL_CHATGPT : 'sessions.show.chatgpt');
		if (opened === false || signal.aborted) return;
		await this.chat.select(id);
		if (!signal.aborted) this.editors.focusActiveEditor();
	}

	private action(id: string, label: string, icon: IAction['icon'], run: () => unknown): IAction {
		return { id: `sessions.chatgpt.${id}`, label, tooltip: label, icon, enabled: true, run };
	}

	private conversationCatalogId(id: string): string {
		return `${this.chat.native ? 'chatgpt-native' : 'chatgpt'}:${id}`;
	}

	private getActions(currentTitle: string, rename: ChatListEntry['rename'], share: ChatListEntry['share'], restoreFocus: () => void): readonly IAction[] {
		if (!rename) return [];
		const actions = [this.action('rename', localize('sessions.chatgpt.rename', 'Rename'), Lxicon.edit, async () => {
			const title = await this.quickInput.input({
				title: localize('sessions.chatgpt.rename', 'Rename'), value: currentTitle,
				validateInput: async value => value.trim() && value.trim().length <= 256 ? undefined : localize('sessions.chatgpt.invalidTitle', 'Enter a name between 1 and 256 characters.'),
			});
			if (title !== undefined) await rename(title);
			restoreFocus();
		})];
		if (share) {
			actions.push(new Separator(), this.action('share', localize('sessions.chatgpt.share', 'Share'), Lxicon.share, share));
		}
		return actions;
	}

}

export class ChatGPTNativeList extends Disposable implements ChatListSource {
	private readonly delegate: ChatGPTList;
	readonly snapshot;
	readonly onDidRetirePreferenceIdentity;

	constructor(
		@IChatGPTNativeService chat: IChatGPTService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const scope = this._register(instantiation.createChild(new ServiceCollection([IChatGPTService, chat])));
		this.delegate = this._register(scope.createInstance(ChatGPTList));
		this.snapshot = this.delegate.snapshot;
		this.onDidRetirePreferenceIdentity = this.delegate.onDidRetirePreferenceIdentity;
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): DisposableStore {
		return this.delegate.attach(window, isVisible);
	}

	loadMore(): void { this.delegate.loadMore(); }

	archiveProjectMembers(references: ReadonlySet<string>): Promise<ReadonlySet<string>> {
		return this.delegate.archiveProjectMembers(references);
	}
}
