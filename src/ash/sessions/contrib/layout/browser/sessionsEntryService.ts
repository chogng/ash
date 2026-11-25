import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { BROWSER_FOLLOWS_SESSION_SETTING } from '../common/sessionsLayoutConfiguration.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableValue } from '../../../../base/common/observable.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { SessionsCodeEditorContext } from '../../../../workbench/common/contextkeys.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IEditorService, type EditorOpenTarget } from '../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService, StartupKind } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import { ISessionsEntryService, type ISessionsEntry, type ISessionsEntryOpenOptions } from '../../../services/layout/common/sessionsEntryService.js';
import { CODE_NAVIGATION_CONTAINER_ID, SESSIONS_NAVIGATION_CONTAINER_ID } from '../../sessions/browser/views/sessionsView.js';
import { ChatConversationPageContext, CodeConversationPageContext, NewSessionDraftVisibleContext, SessionsEntryDetailsContext, SessionsEntryShowsWorkspaceModeControlContext, SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { BaseLayoutController } from './baseSessionLayoutController.js';
import { DesktopLayoutController, type IDesktopLayoutContext } from './desktopLayoutController.js';
import { registerDesktopEditorLayoutActions } from '../../../browser/layoutActions.js';
import { registerChangesEditorTitleActions } from '../../changes/browser/changesActions.js';
import { registerSessionsModalEditorActions } from '../../editor/browser/editor.contribution.js';
import { registerSessionsTerminalTitleActions } from '../../terminal/browser/sessionsTerminalContribution.js';
import { ISessionsConversationService } from '../../../services/sessions/common/sessionsConversation.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { CHAT_WORKSPACE_ENTRY_REQUEST, SHOW_CHAT_WORKSPACE_COMMAND } from '../../../common/chatWorkspace.js';
import { parseEditorWorkingSet, type EditorWorkingSet } from '../../../../workbench/services/editor/common/editorWorkingSet.js';

export const documentEntry: ISessionsEntry = {
	id: 'code', workspaceMode: 'code', activityContext: CodeConversationPageContext.key, content: 'documents',
	sidebarContainerId: CODE_NAVIGATION_CONTAINER_ID, restoreCommand: 'sessions.open.code', newDraft: 'conversation', focus: 'editor',
};

interface EntryVisibility {
	readonly details: boolean;
	readonly documents: boolean;
}

type ActiveEntry = ISessionsEntry & { readonly chatActivityContext?: string; };

const visibilityKey = 'sessions.layout.entryVisibility';
const activeEntryKey = 'sessions.layout.activeEntry';
const activeEntryModeKey = 'sessions.layout.activeEntryMode';
const conversationEditorsKey = 'sessions.layout.conversationEditors';
const conversationFilesPrefix = 'files:';

/** Applies feature-supplied entries without owning their resource or workspace selection. */
export class SessionsEntryService extends Disposable implements ISessionsEntryService, IDesktopLayoutContext {
	public checkpointEditorLayout(): Promise<void> { return this.controller.checkpointEditorLayout(); }
	private readonly controller: DesktopLayoutController;
	private readonly activeEntry = observableValue<ActiveEntry | undefined>(this, undefined);
	private readonly workspaceMode = derived(reader => this.activeEntry.read(reader)?.workspaceMode === 'code' ? 'code' : 'chat');
	public readonly documentContent = derived(reader => !this.customViews.activeCustomView.read(reader) && this.activeEntry.read(reader)?.content === 'documents');
	private readonly chatConversation = derived(reader => {
		const entry = this.activeEntry.read(reader);
		return !this.customViews.activeCustomView.read(reader) && entry?.content === 'conversation'
			&& entry.workspaceMode !== 'code' && (entry.id === 'chat' || entry.chatSource !== undefined);
	});
	private readonly visibility = new Map<string, EntryVisibility>();
	private readonly workspaceSidebars = new Map<'chat' | 'code', string>();
	private readonly editorEntries = new Map<string, ISessionsEntry>();
	private readonly activeBrowserKey = observableValue<string | undefined>(this, undefined);
	public readonly conversationBrowserContext = derived(reader => {
		const entry = this.activeEntry.read(reader);
		return entry?.content === 'conversation' && entry.chatSource ? this.activeBrowserKey.read(reader) ?? entry.id : undefined;
	});
	private readonly conversationGroups = new Map<string, number>();
	private readonly fileReturnFocus = new WeakMap<IResourceEditorInput, () => void>();
	private readonly savedConversationEditors = new Map<string, EditorWorkingSet>();
	private readonly activityKeys = new Map<string, IContextKey<boolean>>();
	private readonly pageGroupId: number;
	private navigationQueue = Promise.resolve();
	public isChangingContent = false;
	public get isSessionContent(): boolean { return !this.customViews.activeCustomView.get() && this.activeEntry.get()?.content !== 'editor'; }
	public readonly sessionEditorRestorationEnabled = derived(reader => {
		const entry = this.activeEntry.read(reader);
		return !this.customViews.activeCustomView.read(reader) && entry?.content !== 'editor' && !entry?.chatSource;
	});
	public get isDocumentContent(): boolean { return this.documentContent.get(); }
	public get newSessionCommand(): string | undefined { return this.customViews.activeCustomView.get() ? undefined : this.activeEntry.get()?.newSessionCommand; }
	private conversationGroupKey(tool: 'browser' | 'files'): string | undefined {
		const entry = this.activeEntry.get();
		if (entry?.content !== 'conversation' || (tool === 'browser' ? !entry.chatSource : entry.workspaceMode === 'code')) return undefined;
		return tool === 'files' ? conversationFilesPrefix + entry.id : this.activeBrowserKey.get() ?? entry.id;
	}
	private getConversationGroup(tool: 'browser' | 'files') {
		const key = this.conversationGroupKey(tool);
		return this.editor.groups.find(group => key !== undefined && group.id === this.conversationGroups.get(key));
	}
	private get hasConversationEditors(): boolean {
		return this.conversationEditors.length > 0 || !!this.getConversationGroup('files')?.inputs.length;
	}
	public get conversationEditors(): readonly IResourceEditorInput[] { return this.getConversationGroup('browser')?.inputs ?? []; }
	public isConversationEditorGroup(id: number): boolean { return [...this.conversationGroups.values()].includes(id); }
	public isActiveConversationEditorGroup(id: number): boolean {
		return this.getConversationGroup('browser')?.id === id || this.getConversationGroup('files')?.id === id;
	}
	public isConversationEditor(resource: URI, activeOnly = false): boolean {
		const groups = this.editor.groups.filter(group => activeOnly ? this.isActiveConversationEditorGroup(group.id) : this.isConversationEditorGroup(group.id));
		return groups.some(group => group.inputs.some(input => extUri.isEqual(input.resource, resource)));
	}

	public openConversationBrowser(open: (target: EditorOpenTarget) => Promise<void>): Promise<void> {
		return this.openConversationEditor('browser', open);
	}

	public async openConversationFile(input: IResourceEditorInput, restoreFocus: () => void, signal: AbortSignal): Promise<void> {
		const entry = this.activeEntry.get();
		if (signal.aborted || !entry || entry.workspaceMode === 'code') return;
		if (entry.content !== 'conversation' || this.customViews.activeCustomView.get()) {
			const command = CommandsRegistry.hasCommand(SHOW_CHAT_WORKSPACE_COMMAND) ? SHOW_CHAT_WORKSPACE_COMMAND : 'sessions.open.chat';
			await this.commands.executeCommand(command);
		}
		signal.throwIfAborted();
		await this.activeEntry.get()?.openDocumentConversation?.(input.resource, signal);
		signal.throwIfAborted();
		await this.openConversationEditor('files', async target => {
			await this.editors.openEditor(input, { pinned: true }, target);
			const opened = this.getConversationGroup('files')?.inputs.find(candidate => extUri.isEqual(candidate.resource, input.resource));
			if (opened) this.fileReturnFocus.set(opened, restoreFocus);
		}, signal);
	}

	private openConversationEditor(tool: 'browser' | 'files', open: (target: EditorOpenTarget) => Promise<void>, signal?: AbortSignal): Promise<void> {
		const source = this.activeEntry.get();
		return this.runOperation(async () => {
			const key = this.conversationGroupKey(tool);
			if (!key || signal?.aborted || this.activeEntry.get() !== source || this.customViews.activeCustomView.get()) return;
			this.isChangingContent = true;
			try {
				let group = this.getConversationGroup(tool);
				if (!group) {
					group = (this.editor as EditorParts).createRetainedGroup(tool);
					this.conversationGroups.set(key, group.id);
				}
				await open({ groupId: group.id });
				if (!this.isDisposed && (tool === 'browser' || group.inputs.length)) {
					if (tool === 'files') this.layout.setPartAvailable('sessions', true);
					this.layout.showPart('editor');
					this.editors.focusActiveEditor();
				}
			} finally { this.isChangingContent = false; }
		});
	}

	constructor(
		@IEditorPart private readonly editor: IEditorPart,
		@IEditorService private readonly editors: IEditorService,
		@IViewsService private readonly views: IViewsService,
		@IViewDescriptorService private readonly viewDescriptors: IViewDescriptorService,
		@ILayoutService private readonly layout: IAgentWorkbenchLayoutService,
		@IStorageService private readonly storage: IStorageService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IInstantiationService instantiation: IInstantiationService,
		@ISessionsConversationService private readonly conversation: ISessionsConversationService,
		@ICustomViewService private readonly customViews: ICustomViewService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.pageGroupId = (editor as EditorParts).pageGroupId;
		const savedEditors: unknown = JSON.parse(storage.get(conversationEditorsKey, StorageScope.WORKSPACE) ?? '{}');
		if (!isRecord(savedEditors)) throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
		for (const [id, state] of Object.entries(savedEditors)) {
			this.savedConversationEditors.set(id, parseEditorWorkingSet(state as EditorWorkingSet, Math.max(...editor.groups.map(group => group.id))));
		}
		const raw = storage.get(visibilityKey, StorageScope.PROFILE) ?? storage.get('sessions.layout.modeState', StorageScope.PROFILE);
		if (raw !== undefined) {
			const value: unknown = JSON.parse(raw);
			if (!isRecord(value)) {
				throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
			}
			for (const [id, state] of Object.entries(value)) {
				if (!isRecord(state) || ['details', 'documents'].some(field => typeof state[field] !== 'boolean')) {
					throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
				}
				this.visibility.set(id, { details: state.details, documents: state.documents } as EntryVisibility);
			}
			storage.store(visibilityKey, JSON.stringify(Object.fromEntries(this.visibility)), StorageScope.PROFILE, StorageTarget.MACHINE);
			storage.remove('sessions.layout.modeState', StorageScope.PROFILE);
		}
		const legacyVisibility = storage.get('sessions.singlePane.sidePaneVisibility', StorageScope.WORKSPACE);
		if (legacyVisibility !== undefined) {
			const value: unknown = JSON.parse(legacyVisibility);
			if (!isRecord(value) || typeof value.editor !== 'boolean' || typeof value.details !== 'boolean') {
				throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
			}
			if (!this.visibility.has(documentEntry.id)) {
				this.visibility.set(documentEntry.id, { details: value.details, documents: value.editor });
			}
			storage.store(visibilityKey, JSON.stringify(Object.fromEntries(this.visibility)), StorageScope.PROFILE, StorageTarget.MACHINE);
			storage.remove('sessions.singlePane.sidePaneVisibility', StorageScope.WORKSPACE);
		}
		this.controller = this._register(instantiation.createInstance(DesktopLayoutController, this.pageGroupId, this));
		this.controller.start();
		const codeEditor = SessionsCodeEditorContext.bindTo(this.contextKeys);
		const chatConversation = ChatConversationPageContext.bindTo(this.contextKeys);
		this._register(toDisposable(() => {
			codeEditor.reset();
			chatConversation.reset();
		}));
		this._register(autorun(reader => {
			const code = this.documentContent.read(reader);
			const chat = this.chatConversation.read(reader);
			this.contextKeys.bufferChangeEvents(() => {
				codeEditor.set(code);
				chatConversation.set(chat);
			});
		}));
		this._register((editor as EditorParts).bindWindowEditorReturn(async () => {
			// Code restores its session's editor groups on entry. Pick the destination after that restore.
			if (!this.isDocumentContent) await this.openEntry(documentEntry);
			await this.controller.whenSettled();
		}));
		this._register(registerDesktopEditorLayoutActions(this.controller, this, contextKeys, layout, editor as EditorParts));
		this._register(registerChangesEditorTitleActions(editor));
		this._register(registerSessionsTerminalTitleActions(editor, contextKeys, configuration));
		this._register(registerSessionsModalEditorActions(editor as EditorParts, () => this.isDocumentContent));
		this._register(BaseLayoutController.registerSidePaneToggleAction(() => {
			const entry = this.activeEntry.get();
			if (!this.isDocumentContent && !this.chatConversation.get()) return;
			return this.runOperation(async () => {
				if (this.activeEntry.get() !== entry || (!this.isDocumentContent && !this.chatConversation.get())) return;
				const visible = layout.toggleSidePane();
				status(visible
					? localize('sessions.layout.sidePaneShown', 'Side panel shown')
					: localize('sessions.layout.sidePaneHidden', 'Side panel hidden'));
			});
		}));
		this._register(storage.onWillSaveState(() => this.saveVisibility()));
		this._register(lifecycle.onWillShutdown(event => event.join(this.navigationQueue.then(() => this.saveVisibility()), 'Sessions entry layout')));
		this._register(lifecycle.onDidShutdown(() => this.dispose()));
		const revealActiveEditor = (explicit = false): void => {
			if (this.customViews.activeCustomView.get()) { return; }
			if (editor.isModalEditorVisible || this.isChangingContent || this.controller.isRestoringEditors || !editors.activeEditor) { return; }
			if (!(editor as EditorParts).mainWindowGroups.some(group => group.id === editor.activeGroup.id)) return;
			if (this.isConversationEditorGroup(editor.activeGroup.id)) {
				if (explicit && this.isActiveConversationEditorGroup(editor.activeGroup.id)) this.layout.showPart('editor');
				return;
			}
			if (editor.activeGroup.id === this.pageGroupId && !editor.isGroupVisible(this.pageGroupId)) { return; }
			const entry = this.editorEntries.get(extUri.getComparisonKey(editors.activeEditor.resource)) ?? documentEntry;
			if (entry.id !== this.activeEntry.get()?.id) {
				void this.openEntry(entry).then(() => {
					if (explicit && !this.isDisposed && this.isDocumentContent) return this.runOperation(() => this.controller.showEditor());
				}).catch(error => { if (!this.isDisposed) { notifications.error(String(error)); } });
			} else if (entry.content === 'documents' && explicit) {
				void this.runOperation(() => this.controller.showEditor()).catch(error => { if (!this.isDisposed) { notifications.error(String(error)); } });
			}
		};
		this._register((editor as EditorParts).onDidRevealActiveEditor(() => revealActiveEditor(true)));
		this._register(editor.onDidChangeEditors(event => {
			if (event.kind === 'groupRemoved') {
				for (const [key, id] of this.conversationGroups) {
					if (id === event.groupId) {
						this.conversationGroups.delete(key);
						this.savedConversationEditors.delete(key);
					}
				}
			}
			if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
				const { input, isActive } = event.event.editor;
				const restore = this.fileReturnFocus.get(input);
				this.fileReturnFocus.delete(input);
				if (this.isActiveConversationEditorGroup(event.groupId)) {
					if (editor.isGroupVisible(event.groupId) && !editor.groups.find(group => group.id === event.groupId)?.inputs.length) {
						editor.setGroupVisible(event.groupId, false);
					}
					if (!this.hasConversationEditors) {
						this.layout.setPartAvailable('sessions', true);
						this.layout.hidePart('editor');
						if (!this.isChangingContent) this.layout.focus();
					}
					if (restore && isActive && event.event.reason === 'close') {
						const entry = this.activeEntry.get();
						// The group may focus its next tab while completing the close event.
						queueMicrotask(() => {
							if (!this.isDisposed && this.activeEntry.get() === entry && !this.customViews.activeCustomView.get()) restore();
						});
					}
				}
			}
			const activeGroup = editor.activeGroup.id;
			const activeTabChanged = event.kind === 'groupChanged' && event.groupId === activeGroup && event.event.kind === 'activeEditorChanged';
			// Retained Code groups can change while hidden in Chat. Only an explicit reveal may navigate to a hidden group.
			if ((event.kind === 'activeGroupChanged' || activeTabChanged) && editor.isGroupVisible(activeGroup)) { revealActiveEditor(activeTabChanged); }
		}));
		this._register(toDisposable(() => {
			for (const key of this.activityKeys.values()) { key.reset(); }
		}));
		const workspaceMode = SessionsWorkspaceModeContext.bindTo(this.contextKeys);
		this._register(toDisposable(() => workspaceMode.reset()));
		this._register(autorun(reader => workspaceMode.set(this.workspaceMode.read(reader))));
		this._register(autorun(reader => {
			const opening = this.customViews.activeCustomViewOpen.read(reader);
			const entryCommand = opening?.descriptor.entryCommand;
			if (entryCommand && opening.source !== 'restore') {
				void this.commands.executeCommand(entryCommand, 'restore').catch(error => {
					if (!this.isDisposed) this.notifications.error(String(error));
				});
			}
		}));
		const newDraftVisible = NewSessionDraftVisibleContext.bindTo(this.contextKeys);
		const entryShowsWorkspaceModeControl = SessionsEntryShowsWorkspaceModeControlContext.bindTo(this.contextKeys);
		const entryDetails = SessionsEntryDetailsContext.bindTo(this.contextKeys);
		this._register(toDisposable(() => {
			newDraftVisible.reset();
			entryShowsWorkspaceModeControl.reset();
			entryDetails.reset();
		}));
		const followBrowser = observableConfigValue(BROWSER_FOLLOWS_SESSION_SETTING, false, configuration);
		this._register(autorun(reader => {
			const entry = this.activeEntry.read(reader);
			const context = entry?.browserContext?.read(reader);
			const follow = followBrowser.read(reader);
			const key = entry && follow && context ? JSON.stringify([entry.id, context]) : entry?.id;
			if (entry?.chatSource && key !== this.activeBrowserKey.get()) {
				void this.applyEntry(entry, undefined, { source: 'restore' }, true).catch(error => { if (!this.isDisposed) this.notifications.error(String(error)); });
			}
		}));
		let activeActivities = new Set<string>();
		this._register(autorun(reader => {
			const entry = this.activeEntry.read(reader);
			const covered = this.customViews.activeCustomView.read(reader) !== undefined;
			const draft = entry?.newDraft === 'conversation' ? this.conversation.newDraftVisible : entry?.newDraft;
			const showingDraft = !covered && (draft?.read(reader) ?? false);
			this.contextKeys.bufferChangeEvents(() => {
				const activities = new Set(entry ? [entry.activityContext] : []);
				if (entry?.chatActivityContext) activities.add(entry.chatActivityContext);
				for (const id of activeActivities) {
					if (!activities.has(id)) this.activityKeys.get(id)?.reset();
				}
				for (const id of activities) {
					let key = this.activityKeys.get(id);
					if (!key) { key = this.contextKeys.createKey(id, false); this.activityKeys.set(id, key); }
					key.set(!covered);
				}
				activeActivities = activities;
				newDraftVisible.set(showingDraft);
				entryShowsWorkspaceModeControl.set(covered || entry?.showWorkspaceModeControl !== false);
				entryDetails.set(covered ? undefined : entry?.detailsContainerId);
			});
		}));
	}

	public runOperation(operation: () => Promise<void>): Promise<void> {
		const pending = this.navigationQueue.then(async () => {
			if (this.isDisposed) { return; }
			await operation();
			if (!this.isDisposed) { this.saveVisibility(); }
		});
		this.navigationQueue = pending.catch(error => { if (!this.isDisposed) { this.notifications.error(String(error)); } });
		return pending;
	}

	public openEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry, options?: ISessionsEntryOpenOptions): Promise<void> {
		return this.applyEntry(entry, initialize, options);
	}

	private applyEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry, options?: ISessionsEntryOpenOptions, refreshBrowser = false): Promise<void> {
		if (options?.source !== 'restore' && this.customViews.activeCustomView.get()) this.customViews.hideCustomView();
		return this.runOperation(async () => {
			if (refreshBrowser && this.activeEntry.get() !== entry) return;
			// A conversation open can reuse the active entry without reapplying its document layout.
			if (options?.focus === 'conversation' && !initialize && this.activeEntry.get() === entry) {
				if (!this.customViews.activeCustomView.get()) { this.layout.focus(); }
				return;
			}
			await this.controller.prepareContentChange();
			if (this.isDisposed) { return; }
			const previousEntry = this.activeEntry.get();
			const sharedWorkspace = entry.workspaceMode === 'current';
			const retainedMode = previousEntry
				? previousEntry.workspaceMode ?? 'chat'
				: options?.source === 'restore' ? this.storage.get(activeEntryModeKey, StorageScope.WORKSPACE) : undefined;
			if (entry.content !== 'editor' && !entry.chatSource && (entry.conversationKind || !sharedWorkspace || !previousEntry)) {
				await this.conversation.setConversationKind(entry.conversationKind ?? (entry.content === 'documents' || (sharedWorkspace && retainedMode === 'code') ? 'code' : 'chat'));
			}
			if (this.isDisposed) { return; }
			this.saveVisibility();
			this.isChangingContent = true;
			try {
				if (entry.editorInput) {
					await this.editors.openEditor(entry.editorInput, { pinned: true }, { groupId: this.pageGroupId });
				}
				if (this.isDisposed) { return; }
				entry = initialize ? initialize() : entry;
				// Keep the editor's entry independent of the Chat source selected when it was opened.
				const editorEntry = entry;
				let chatActivityContext: string | undefined;
				if (entry.content === 'editor' && entry.conversation) {
					const command = CommandsRegistry.hasCommand(SHOW_CHAT_WORKSPACE_COMMAND) ? SHOW_CHAT_WORKSPACE_COMMAND : 'sessions.open.chat';
					const chat = previousEntry?.chatSource ? previousEntry
						: await this.commands.executeCommand<ISessionsEntry>(command, CHAT_WORKSPACE_ENTRY_REQUEST);
					if (this.isDisposed) return;
					entry = { ...entry, workspaceMode: 'chat', sidebarContainerId: chat.sidebarContainerId, chatSource: chat.chatSource };
					if (chat.chatSource) chatActivityContext = previousEntry?.chatActivityContext ?? chat.activityContext;
					else await this.conversation.setConversationKind(chat.conversationKind ?? 'chat');
				}
				if (this.isDisposed) { return; }
				if (editorEntry.editorInput) { this.editorEntries.set(extUri.getComparisonKey(editorEntry.editorInput.resource), editorEntry); }
				if (entry.workspaceMode === 'current') {
					entry = { ...entry, workspaceMode: retainedMode === 'code' ? 'code' : 'chat' };
				}
				this.conversation.setChatSource(entry.chatSource);
				const visibleSidebar = this.views.getVisibleViewContainer(ViewContainerLocation.Sidebar)?.id;
				// A product page can borrow the sidebar without becoming the workspace's default navigation.
				if (previousEntry && visibleSidebar && (previousEntry.content !== 'editor' || previousEntry.sidebarContainerId !== visibleSidebar)) {
					this.workspaceSidebars.set(previousEntry.workspaceMode === 'code' ? 'code' : 'chat', visibleSidebar);
				}
				const mode = entry.workspaceMode === 'code' ? 'code' : 'chat';
				const sameWorkspace = previousEntry && (previousEntry.workspaceMode ?? 'chat') === mode;
				const defaultNavigation = this.viewDescriptors.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id;
				const sidebarContainerId = entry.sidebarContainerId
					?? (sharedWorkspace && entry.workspaceMode === 'code' ? CODE_NAVIGATION_CONTAINER_ID : undefined)
					?? (sameWorkspace ? this.workspaceSidebars.get(mode) : undefined)
					?? defaultNavigation
					?? SESSIONS_NAVIGATION_CONTAINER_ID;
				const context = entry.browserContext?.get();
				const browserKey = this.configuration.getValue<boolean>(BROWSER_FOLLOWS_SESSION_SETTING) && context
					? JSON.stringify([entry.id, context]) : entry.id;
				// Changing the preference adopts the visible tabs; switching conversations keeps their groups separate.
				const previousKey = this.activeBrowserKey.get();
				const changingScope = previousEntry?.id === entry.id && previousKey !== browserKey
					&& (previousKey === entry.id || browserKey === entry.id);
				if (changingScope && previousKey && !this.conversationGroups.has(browserKey)) {
					const group = this.conversationGroups.get(previousKey);
					if (group !== undefined) {
						this.conversationGroups.delete(previousKey);
						this.savedConversationEditors.delete(previousKey);
						this.conversationGroups.set(browserKey, group);
					}
					const previousVisibility = this.visibility.get(previousKey);
					if (previousVisibility && (group !== undefined || !this.visibility.has(browserKey))) {
						this.visibility.set(browserKey, previousVisibility);
					}
				}
				this.activeBrowserKey.set(browserKey, undefined);
				this.activeEntry.set(chatActivityContext ? { ...entry, chatActivityContext } : entry, undefined);
				const productEditor = entry.content === 'editor';
				const documents = entry.content === 'documents';
				const chatConversation = this.chatConversation.get();
				// Navigation visibility belongs to the window, independently of the page's side content.
				const sidebarVisible = this.layout.isPartRequested('sidebar');
				const state = this.visibility.get(chatConversation ? browserKey : entry.id) ?? {
					details: entry.showDetailsByDefault ?? entry.detailsContainerId !== undefined,
					documents: documents ? this.controller.hasDocumentEditors : this.hasConversationEditors,
				};
				const detailsContainerId = !documents && state.details ? entry.detailsContainerId : undefined;
				this.layout.updateParts(() => {
					this.controller.setDocumentGroupsVisible(documents);
					for (const groupId of this.conversationGroups.values()) {
						const group = this.editor.groups.find(candidate => candidate.id === groupId);
						if (group) this.editor.setGroupVisible(groupId, this.isActiveConversationEditorGroup(groupId) && (chatConversation || state.documents) && group.inputs.length > 0);
					}
					this.editor.setGroupVisible(this.pageGroupId, productEditor);
					this.editor.groups.find(group => group.id === this.pageGroupId)!.setTitleVisible(entry.showEditorTabs !== false);
					if (!productEditor && this.editor.activeGroup.id === this.pageGroupId) {
						const group = this.editor.groups.find(group => group.id !== this.pageGroupId && this.editor.isGroupVisible(group.id));
						if (group) this.editor.activateGroup(group.id);
					}
					// Hide an outgoing conversation before separating editor details so transient minimum widths cannot shrink navigation.
					if (!productEditor) { this.layout.setPrimaryPart('sessions'); }
					this.layout.setPartAvailable('sessions', !productEditor || entry.conversation === 'visible');
					this.layout.setAuxiliaryBarDocked(productEditor && entry.detailsContainerId !== undefined);
					if (productEditor) { this.layout.setPrimaryPart('editor'); }
					this.setVisible('editor', productEditor || (state.documents && (documents || chatConversation || this.hasConversationEditors)));
					// A saved visibility flag can outlive the view that once occupied the side bar.
					if (!detailsContainerId || this.views.getVisibleViewContainer(ViewContainerLocation.AuxiliaryBar)?.id !== detailsContainerId) {
						this.layout.hidePart('auxiliarybar');
					}
				});
				const focusSidebar = entry.focus === 'sidebar' && sidebarVisible && !this.customViews.activeCustomView.get();
				// Keep the workspace sidebar attached while only the central page changes.
				const sidebar = this.views.getVisibleViewContainer(ViewContainerLocation.Sidebar)?.id !== sidebarContainerId || focusSidebar
					? await this.views.openViewContainer(sidebarContainerId, false)
					: null;
				if (this.isDisposed) { return; }
				this.setVisible('sidebar', sidebarVisible);
				if (detailsContainerId) {
					const details = await this.views.openViewContainer(detailsContainerId);
					if (this.isDisposed) { return; }
					if (!details) { this.layout.hidePart('auxiliarybar'); }
				}
				if (documents && !this.customViews.activeCustomView.get()) {
					const filesDetailsOpen = (this.editor as EditorParts).filesDetailsOpen
						|| this.storage.getBoolean('sessions.code.filesVisible', StorageScope.PROFILE, false);
					// A retained Files preference must not open a side pane that is closed.
					await this.controller.activate(state.documents && filesDetailsOpen);
				}
				if (this.isDisposed) { return; }
				this.storage.store(activeEntryKey, entry.restoreCommand, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				this.storage.store(activeEntryModeKey, sharedWorkspace ? entry.workspaceMode : undefined, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				// Reveal the first composition before handing focus to any of its Parts.
				this.layout.mainContainer.classList.remove('restoring-entry');
				// Retain the feature's initializer so history restores its selected workspace as well as its host.
				const destination = sharedWorkspace ? { ...editorEntry, workspaceMode: entry.workspaceMode } : editorEntry;
				const selection = this.sessions.activeSelection;
				const navigationId = entry.editorInput
					? JSON.stringify([entry.id, entry.workspaceMode, extUri.getComparisonKey(entry.editorInput.resource)]) : entry.id;
				if (!this.customViews.activeCustomView.get()) this.sessions.recordEntryNavigation(navigationId, async () => {
					if (destination.content !== 'editor' && !destination.chatSource && selection) this.sessions.activateSelection(selection);
					await this.openEntry(destination, initialize);
				}, entry.content !== 'editor');
				if (this.customViews.activeCustomView.get()) { return; }
				if ((options?.focus ?? entry.focus) === 'conversation') { this.layout.focus(); }
				else if (entry.focus === 'editor') { documents ? this.controller.focus() : this.editors.focusActiveEditor(); }
				else if (!sidebarVisible) { this.layout.focus(); }
				else if (focusSidebar) { sidebar?.focus(); }
			} finally { this.isChangingContent = false; }
		});
	}

	public async replaceEditorResource(sourceGroupId: number, input: IResourceEditorInput, replacement: IResourceEditorInput): Promise<void> {
		const parts = this.editor as EditorParts;
		const source = parts.groups.find(group => group.id === sourceGroupId);
		if (!source) throw new RangeError(`Unknown editor group '${sourceGroupId}'`);
		const inputKey = extUri.getComparisonKey(input.resource);
		const entry = sourceGroupId === this.pageGroupId ? this.editorEntries.get(inputKey) : undefined;
		if (!entry) return parts.replaceEditorResource(source, input, replacement);
		const replacementKey = extUri.getComparisonKey(replacement.resource);
		const previous = this.editorEntries.get(replacementKey);
		// The editor group publishes activation before the old tab closes.
		this.editorEntries.set(replacementKey, { ...entry, editorInput: replacement });
		try {
			await parts.replaceEditorResource(source, input, replacement);
		} catch (error) {
			if (previous) this.editorEntries.set(replacementKey, previous);
			else this.editorEntries.delete(replacementKey);
			throw error;
		}
		if (inputKey !== replacementKey) this.editorEntries.delete(inputKey);
		const active = this.activeEntry.get();
		if (active?.editorInput && extUri.isEqual(active.editorInput.resource, input.resource)) {
			this.activeEntry.set({ ...active, editorInput: replacement }, undefined);
		}
		entry.onEditorInputReplaced?.(input, replacement);
	}

	public closeConversationEditor(input: IResourceEditorInput): Promise<void> {
		const group = this.getConversationGroup('browser');
		return this.runOperation(async () => {
			if (!group || group !== this.getConversationGroup('browser') || !group.inputs.includes(input)) return;
			this.isChangingContent = true;
			try { await group.closeEditor(input); }
			finally { this.isChangingContent = false; }
		});
	}

	public setConversationVisible(visible: boolean, options?: { readonly preserveFocus?: boolean; }): Promise<void> {
		return this.runOperation(async () => {
			if (!this.activeEntry.get()?.conversation && !this.hasConversationEditors) { throw new Error('The active entry does not support a conversation beside its editor.'); }
			this.layout.updateParts(() => this.layout.setPartAvailable('sessions', visible));
			if (options?.preserveFocus) return;
			if (visible) { this.layout.focus(); }
			else { this.editors.focusActiveEditor(); }
		});
	}

	private setVisible(id: 'sidebar' | 'editor', visible: boolean): void {
		if (visible) { this.layout.showPart(id); }
		else { this.layout.hidePart(id); }
	}

	private saveVisibility(): void {
		const entry = this.activeEntry.get();
		if (this.isDisposed || this.isChangingContent || !entry || this.customViews.activeCustomView.get()) { return; }
		const files = this.isDocumentContent ? (this.editor as EditorParts) : undefined;
		const chatConversation = this.chatConversation.get();
		const key = chatConversation ? this.activeBrowserKey.get() ?? entry.id : entry.id;
		const documents = (this.isDocumentContent || chatConversation || this.hasConversationEditors) && this.layout.isPartRequested('editor');
		if (key !== entry.id && !documents && !this.hasConversationEditors) this.visibility.delete(key);
		else this.visibility.set(key, {
			// File navigation belongs to the retained editor group, independently of properties.
			details: files?.filesDetailsOpen ?? (entry.detailsContainerId !== undefined && this.layout.isPartRequested('auxiliarybar')),
			documents,
		});
		this.storage.store(visibilityKey, JSON.stringify(Object.fromEntries(this.visibility)), StorageScope.PROFILE, StorageTarget.MACHINE);
		for (const [id, groupId] of this.conversationGroups) {
			const group = this.editor.groups.find(group => group.id === groupId);
			if (group?.inputs.length) {
				this.savedConversationEditors.set(id, this.editor.saveWorkingSet(id, this.editor.groups.filter(group => group.id !== groupId).map(group => group.id)));
			} else this.savedConversationEditors.delete(id);
		}
		this.storage.store(conversationEditorsKey, JSON.stringify(Object.fromEntries(this.savedConversationEditors)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	public async restore(): Promise<void> {
		await this.controller.whenSettled();
		if (this.isDisposed) { return; }
		await this.runOperation(async () => {
			this.isChangingContent = true;
			try {
				for (const [id, saved] of this.savedConversationEditors) {
					if (this.conversationGroups.has(id)) continue;
					const group = await (this.editor as EditorParts).restoreRetainedGroup(id.startsWith(conversationFilesPrefix) ? 'files' : 'browser', saved);
					if (this.isDisposed) return;
					this.conversationGroups.set(id, group.id);
				}
			} finally { this.isChangingContent = false; }
		});
		if (this.isDisposed) return;
		const desktopNew = CommandsRegistry.hasCommand('sessions.open.new');
		if (desktopNew && this.lifecycle.startupKind === StartupKind.NewWindow) {
			this.customViews.hideCustomView();
			await this.commands.executeCommand('sessions.open.new', 'startup');
		} else {
			await this.restoreSavedEntry(desktopNew ? 'sessions.open.new' : 'sessions.open.chat');
		}
		if (this.isDisposed) { return; }
		for (const key of ['sessions.layout.activeMode', 'sessions.layout.primaryPage', 'sessions.activityBar.activePage', 'sessions.layout.primaryEditor']) {
			this.storage.remove(key, StorageScope.WORKSPACE);
		}
	}

	private async restoreSavedEntry(defaultEntry: string): Promise<void> {
		const saved = this.customViews.activeCustomView.get()?.entryCommand ?? this.storage.get(activeEntryKey, StorageScope.WORKSPACE);
		// These names describe the discarded storage format, not runtime product selection.
		const oldEditor = this.storage.get('sessions.layout.primaryEditor', StorageScope.WORKSPACE);
		const oldEntry = this.storage.get('sessions.layout.activeMode', StorageScope.WORKSPACE)
			?? this.storage.get('sessions.layout.primaryPage', StorageScope.WORKSPACE)
			?? this.storage.get('sessions.activityBar.activePage', StorageScope.WORKSPACE)
			?? (oldEditor ? URI.parse(oldEditor).scheme.replace(/^ash-/, '') : undefined);
		const oldCommands: Readonly<Record<string, string>> = {
			chat: 'sessions.open.chat', code: 'sessions.open.code', teams: 'sessions.open.teams', colab: 'sessions.open.teams',
			creator: 'sessions.restore.artifacts', design: 'sessions.restore.artifactsDesign',
		};
		if (!saved && oldEntry !== undefined && !Object.hasOwn(oldCommands, oldEntry)) {
			throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
		}
		// Normalize saved navigation state without registering the retired command IDs again.
		const requested = (saved ?? (oldEntry ? oldCommands[oldEntry]! : defaultEntry))
			.replace(/^sessions\.(show|open|restore)\.creator/u, 'sessions.$1.artifacts')
			.replace(/^sessions\.creator\./u, 'sessions.artifacts.')
			.replace(/^sessions\.restore\.artifactsDocs$/u, 'sessions.restore.docs');
		const available = CommandsRegistry.hasCommand(requested);
		// Entry commands can disappear during development or when a contribution is
		// removed. Discard stale navigation state without invoking an unknown command.
		if (!available) { this.storage.remove(activeEntryKey, StorageScope.WORKSPACE); }
		const command = available ? requested : defaultEntry;
		await this.commands.executeCommand(command, 'restore');
	}
}
