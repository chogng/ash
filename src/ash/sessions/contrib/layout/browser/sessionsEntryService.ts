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
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService, StartupKind } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import { ISessionsEntryService, type ISessionsEntry, type ISessionsEntryOpenOptions } from '../../../services/layout/common/sessionsEntryService.js';
import { CODE_NAVIGATION_CONTAINER_ID, SESSIONS_NAVIGATION_CONTAINER_ID } from '../../sessions/browser/views/sessionsView.js';
import { CodeConversationPageContext, NewSessionDraftVisibleContext, SessionsEntryDetailsContext, SessionsEntryShowsWorkspaceModeControlContext, SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { DesktopLayoutController, type IDesktopLayoutContext } from './desktopLayoutController.js';
import { EditorTitleMenuBridgeContribution } from '../../editor/browser/editor.contribution.js';
import { ISessionsConversationService } from '../../../services/sessions/common/sessionsConversation.js';
import { CHAT_WORKSPACE_ENTRY_REQUEST, SHOW_CHAT_WORKSPACE_COMMAND } from '../../chat/common/constants.js';

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

/** Applies feature-supplied entries without owning their resource or workspace selection. */
export class SessionsEntryService extends Disposable implements ISessionsEntryService, IDesktopLayoutContext {
	public checkpointEditorLayout(): Promise<void> { return this.controller.checkpointEditorLayout(); }
	private readonly controller: DesktopLayoutController;
	private readonly activeEntry = observableValue<ActiveEntry | undefined>(this, undefined);
	private readonly workspaceMode = derived(reader => this.activeEntry.read(reader)?.workspaceMode === 'code' ? 'code' : 'chat');
	public readonly documentContent = derived(reader => !this.customViews.activeCustomView.read(reader) && this.activeEntry.read(reader)?.content === 'documents');
	private readonly visibility = new Map<string, EntryVisibility>();
	private readonly editorEntries = new Map<string, ISessionsEntry>();
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
	) {
		super();
		this.pageGroupId = (editor as EditorParts).pageGroupId;
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
		this._register((editor as EditorParts).bindWindowEditorReturn(async () => {
			// Code restores its session's editor groups on entry. Pick the destination after that restore.
			if (!this.isDocumentContent) await this.openEntry(documentEntry);
			await this.controller.whenSettled();
		}));
		this._register(instantiation.createInstance(EditorTitleMenuBridgeContribution, this.controller, this));
		this._register(storage.onWillSaveState(() => this.saveVisibility()));
		this._register(lifecycle.onWillShutdown(event => event.join(this.navigationQueue.then(() => this.saveVisibility()), 'Sessions entry layout')));
		this._register(lifecycle.onDidShutdown(() => this.dispose()));
		const revealActiveEditor = (explicit = false): void => {
			if (this.customViews.activeCustomView.get()) { return; }
			if (editor.isModalEditorVisible || this.isChangingContent || this.controller.isRestoringEditors || !editors.activeEditor) { return; }
			if (!(editor as EditorParts).mainWindowGroups.some(group => group.id === editor.activeGroup.id)) return;
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
		if (options?.source !== 'restore' && this.customViews.activeCustomView.get()) this.customViews.hideCustomView();
		return this.runOperation(async () => {
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
				const sameWorkspace = previousEntry && (previousEntry.workspaceMode ?? 'chat') === (entry.workspaceMode ?? 'chat');
				const defaultNavigation = this.viewDescriptors.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id;
				const sidebarContainerId = entry.sidebarContainerId
					?? (sharedWorkspace && entry.workspaceMode === 'code' ? CODE_NAVIGATION_CONTAINER_ID : undefined)
					?? (sameWorkspace ? this.views.getVisibleViewContainer(ViewContainerLocation.Sidebar)?.id : undefined)
					?? defaultNavigation
					?? SESSIONS_NAVIGATION_CONTAINER_ID;
				this.activeEntry.set(chatActivityContext ? { ...entry, chatActivityContext } : entry, undefined);
				const productEditor = entry.content === 'editor';
				const documents = entry.content === 'documents';
				// Navigation visibility belongs to the window, independently of the page's side content.
				const sidebarVisible = this.layout.isPartRequested('sidebar');
				const state = this.visibility.get(entry.id) ?? {
					details: entry.showDetailsByDefault ?? entry.detailsContainerId !== undefined,
					documents: documents && this.controller.hasDocumentEditors,
				};
				const detailsContainerId = !documents && state.details ? entry.detailsContainerId : undefined;
				this.controller.setDocumentGroupsVisible(documents);
				this.editor.setGroupVisible(this.pageGroupId, productEditor);
				this.editor.groups.find(group => group.id === this.pageGroupId)!.setTitleVisible(entry.showEditorTabs !== false);
				if (!productEditor && this.editor.activeGroup.id === this.pageGroupId) {
					const group = this.editor.groups.find(group => group.id !== this.pageGroupId && this.editor.isGroupVisible(group.id));
					if (group) this.editor.activateGroup(group.id);
				}
				this.layout.updateParts(() => {
					// Hide an outgoing conversation before separating editor details so transient minimum widths cannot shrink navigation.
					if (!productEditor) { this.layout.setPrimaryPart('sessions'); }
					this.layout.setPartAvailable('sessions', !productEditor || entry.conversation === 'visible');
					this.layout.setAuxiliaryBarDocked(productEditor && entry.detailsContainerId !== undefined);
					if (productEditor) { this.layout.setPrimaryPart('editor'); }
					this.setVisible('editor', productEditor || (documents && state.documents));
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

	public setConversationVisible(visible: boolean, options?: { readonly preserveFocus?: boolean; }): Promise<void> {
		return this.runOperation(async () => {
			if (!this.activeEntry.get()?.conversation) { throw new Error('The active entry does not support a conversation beside its editor.'); }
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
		this.visibility.set(entry.id, {
			// File navigation belongs to the retained editor group, independently of properties.
			details: files?.filesDetailsOpen ?? (entry.detailsContainerId !== undefined && this.layout.isPartRequested('auxiliarybar')),
			documents: this.isDocumentContent && this.layout.isPartRequested('editor'),
		});
		this.storage.store(visibilityKey, JSON.stringify(Object.fromEntries(this.visibility)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	public async restore(): Promise<void> {
		await this.controller.whenSettled();
		if (this.isDisposed) { return; }
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
