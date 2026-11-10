import { addDisposableListener } from '../../../../base/browser/dom.js';
import { disposableWindowInterval, disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { autorun, derived, observableFromEvent, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { SHOW_EXPERIMENTAL_CHATGPT } from '../common/chatGPTNative.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_LAST_BACKEND_KEY } from '../../chat/common/constants.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import type { CatalogProjectDetails, ChatListEntry, ChatListForkReference, ChatListProject, ChatListSnapshot, ChatListSource } from '../../chat/browser/chatListModel.js';
import type { CatalogProjectCreator } from '../../sessions/browser/views/sessionsCatalogList.js';
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
	readonly onDidCreateFork: ChatListSource['onDidCreateFork'];
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
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const onDidCreateFork = chat.onDidCreateFork;
		const readForkEvidence = chat.readForkEvidence?.bind(chat);
		this.onDidCreateFork = onDidCreateFork && (listener => onDidCreateFork(({ id, parentId }) => {
			const state = chat.state.get();
			const key = conversationPreferenceKey(id, state.catalogScope);
			if (key) listener({ key, parent: this.forkReference(parentId, state, state.conversations.find(item => item.id === parentId)?.title) });
		}));
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
			const accountPrefix = state.catalogScope && `${state.catalogScope}:`;
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
					loadForkEvidence: !conversation.local && !id.startsWith('pending:') && state.connected && state.networkAvailable && !state.historyListFailed && readForkEvidence
						? async signal => {
							if (!currentAccount()) throw new CancellationError();
							const evidence = await readForkEvidence(id, signal);
							if (!currentAccount()) throw new CancellationError();
							return { ...evidence, source: evidence.source && this.forkReference(evidence.source.id, state, evidence.source.title) };
						} : undefined,
					openForkSource: accountPrefix && state.connected && state.networkAvailable ? async (source, signal) => {
						const parent = source.preferenceKey?.startsWith(accountPrefix) ? source.preferenceKey.slice(accountPrefix.length) : undefined;
						if (parent && /^[A-Za-z0-9_-]{1,240}$/u.test(parent) && currentAccount()) await this.open(parent, signal);
					} : undefined,
					open: signal => this.open(id, signal),
					rename, share,
					validateRename: name => name.length >= 1 && name.length <= 256
						? undefined
						: localize('sessions.chatgpt.invalidTitle', 'Enter a name between 1 and 256 characters.'),
					remove: async () => { if (currentAccount()) await chat.deleteConversation(id); },
					archive: canManage ? async () => currentAccount() && await chat.archive(id) : undefined,
					setPinned: !id.startsWith('pending:') ? async pinned => { if (currentAccount()) await chat.setPinned(id, pinned); } : undefined,
					project: !conversation.local && !id.startsWith('pending:') && (!projectId || currentProject) && state.connected && state.networkAvailable ? {
						current: currentProject,
						destinations,
						creator: this.projectCreator(state.catalogScope, id),
						move: async destination => {
							if (state.catalogScope !== this.chat.state.get().catalogScope) {
								throw new Error(localize('sessions.chatgpt.projectMoveFailed', 'Could not move this conversation. Try again.'));
							}
							await this.chat.moveToProject(id, destination ?? null);
						},
					} : undefined,
					getActions: share && (() => [{
						id: 'sessions.chatgpt.share',
						label: localize('sessions.chatgpt.share', 'Share'),
						tooltip: localize('sessions.chatgpt.share', 'Share'),
						icon: Lxicon.share, enabled: true, run: share,
					}]),
				};
			});
			return {
				entries,
				projectCreator: state.connected && state.networkAvailable ? this.projectCreator(state.catalogScope) : undefined,
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
						refreshHistory: online ? () => {
							if (isCurrentAccount()) void this.chat.loadProjectConversations(project.id, 'refresh');
						} : undefined,
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

	private projectCreator(scope: string | undefined, conversationId?: string): CatalogProjectCreator {
		return {
			label: 'ChatGPT',
			description: localize('sessions.chatgpt.projectCreationDescription', 'Saved to your current ChatGPT account.'),
			supportsMemoryMode: true,
			create: async details => {
				if (this.chat.state.get().catalogScope !== scope) throw new CancellationError();
				const project = await this.chat.createProject(details, conversationId);
				if (this.chat.state.get().catalogScope !== scope) throw new CancellationError();
				return {
					id: project.id,
					preferenceKey: chatGPTProjectPreferenceKey(scope, project.id),
					warning: project.warning ?? (project.moveFailed ? localize('sessions.chatgpt.projectCreatedMoveFailed', 'Created {0}. Choose it from Move to project to try the move again.', details.name) : undefined),
				};
			},
		};
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
						read: online ? signal => this.chat.readProjectFile(id, scope, file.id, signal) : undefined,
						remove: canEdit ? () => this.chat.removeProjectFile(id, scope, file.id) : undefined,
					})),
				};
			}),
			upload: online ? {
				limits: chatGPTAttachmentLimits,
				limitMessage: chatGPTAttachmentLimitMessage(),
				addFiles: files => this.chat.addProjectFiles(id, scope, files),
			} : undefined,
		};
	}

	private projectHistory(projectId: string, state: ChatGPTState): ChatListProject['history'] {
		const page = state.projectHistory.get(projectId);
		if (page && !page.cursor && (page.status === 'ready' || page.checkedAt !== undefined)) return { state: 'complete' };
		if (!state.connected || !state.networkAvailable) return { state: 'unavailable' };
		if (!page) return { state: 'idle', load: () => this.chat.loadProjectConversations(projectId) };
		if (page.status === 'loading') return { state: page.refreshing ? 'refreshing' : 'loading' };
		if (page.status === 'error') return { state: 'error' };
		return { state: 'more', manual: page.cursor?.kind === 'recent', load: () => this.chat.loadProjectConversations(projectId, 'next') };
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

	private conversationCatalogId(id: string): string {
		return `${this.chat.native ? 'chatgpt-native' : 'chatgpt'}:${id}`;
	}

	private forkReference(id: string, state: ChatGPTState, title: string | undefined): ChatListForkReference {
		return { id: this.conversationCatalogId(id), preferenceKey: conversationPreferenceKey(id, state.catalogScope), title };
	}

}

export class ChatGPTNativeList extends Disposable implements ChatListSource {
	private readonly delegate: ChatGPTList;
	readonly snapshot;
	readonly onDidRetirePreferenceIdentity;
	readonly onDidCreateFork;

	constructor(
		@IChatGPTNativeService chat: IChatGPTService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const scope = this._register(instantiation.createChild(new ServiceCollection([IChatGPTService, chat])));
		this.delegate = this._register(scope.createInstance(ChatGPTList));
		this.snapshot = this.delegate.snapshot;
		this.onDidRetirePreferenceIdentity = this.delegate.onDidRetirePreferenceIdentity;
		this.onDidCreateFork = this.delegate.onDidCreateFork;
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): DisposableStore {
		return this.delegate.attach(window, isVisible);
	}

	loadMore(): void { this.delegate.loadMore(); }

	archiveProjectMembers(references: ReadonlySet<string>): Promise<ReadonlySet<string>> {
		return this.delegate.archiveProjectMembers(references);
	}
}
