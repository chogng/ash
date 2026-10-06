import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { derived, observableValue } from '../../../../base/common/observable.js';
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import type { EditorPart as SessionsEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../services/layout/common/sessionsLayoutService.js';
import { SESSIONS_NAVIGATION_CONTAINER_ID } from '../../../browser/parts/sidebar/sidebarPart.js';
import { DesktopLayoutController, type IDesktopLayoutContext } from './desktopLayoutController.js';

export const documentEntry: ISessionsEntry = {
	id: 'code', activityContext: 'sessions.activity.codeSelected', content: 'documents',
	sidebarContainerId: SESSIONS_NAVIGATION_CONTAINER_ID, restoreCommand: 'sessions.open.code', focus: 'editor',
};

interface EntryVisibility {
	readonly sidebar: boolean;
	readonly details: boolean;
	readonly panel: boolean;
	readonly documents: boolean;
}

const visibilityKey = 'sessions.layout.entryVisibility';
const activeEntryKey = 'sessions.layout.activeEntry';

/** Applies feature-supplied entries without owning their resource or workspace selection. */
export class SessionsLayoutService extends Disposable implements ISessionsLayoutService, IDesktopLayoutContext {
	private readonly conversationChanged = this._register(new Emitter<void>());
	public readonly onDidChangeConversationVisibility = this.conversationChanged.event;
	public get conversationVisible(): boolean { return this.activeEntry.get()?.conversation === 'optional' && this.layout.isPartVisible('sessions'); }
	private readonly controller: DesktopLayoutController;
	private readonly activeEntry = observableValue<ISessionsEntry | undefined>(this, undefined);
	public readonly documentContent = derived(reader => this.activeEntry.read(reader)?.content === 'documents');
	private readonly visibility = new Map<string, EntryVisibility>();
	private readonly editorEntries = new Map<string, ISessionsEntry>();
	private readonly activityKeys = new Map<string, IContextKey<boolean>>();
	private readonly pageGroupId: string;
	private navigationQueue = Promise.resolve();
	public isChangingContent = false;
	public get isSessionContent(): boolean { return this.activeEntry.get()?.content !== 'editor'; }
	public get isDocumentContent(): boolean { return this.documentContent.get(); }

	constructor(
		@IEditorPart private readonly editor: IEditorPart,
		@IEditorService private readonly editors: IEditorService,
		@IViewsService private readonly views: IViewsService,
		@ILayoutService private readonly layout: IAgentWorkbenchLayoutService,
		@IStorageService private readonly storage: IStorageService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.pageGroupId = (editor as SessionsEditorPart).pageGroupId;
		const raw = storage.get(visibilityKey, StorageScope.PROFILE) ?? storage.get('sessions.layout.modeState', StorageScope.PROFILE);
		if (raw !== undefined) {
			const value: unknown = JSON.parse(raw);
			if (!isRecord(value)) { throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.')); }
			for (const [id, state] of Object.entries(value)) {
				if (!isRecord(state) || ['sidebar', 'details', 'panel', 'documents'].some(field => typeof state[field] !== 'boolean')) {
					throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
				}
				this.visibility.set(id, { sidebar: state.sidebar, details: state.details, panel: state.panel, documents: state.documents } as EntryVisibility);
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
				this.visibility.set(documentEntry.id, { sidebar: true, details: value.details, panel: false, documents: value.editor });
			}
			storage.store(visibilityKey, JSON.stringify(Object.fromEntries(this.visibility)), StorageScope.PROFILE, StorageTarget.MACHINE);
			storage.remove('sessions.singlePane.sidePaneVisibility', StorageScope.WORKSPACE);
		}
		this.controller = this._register(instantiation.createInstance(DesktopLayoutController, this.pageGroupId, this));
		this.controller.start();
		this._register(storage.onWillSaveState(() => this.saveVisibility()));
		this._register(lifecycle.onWillShutdown(event => event.join(this.navigationQueue.then(() => this.saveVisibility()), 'Sessions entry layout')));
		this._register(editors.onDidActiveEditorChange(() => {
			if (this.isChangingContent || this.controller.isRestoringEditors || !editors.activeEditor) { return; }
			const entry = this.editorEntries.get(extUri.getComparisonKey(editors.activeEditor.resource)) ?? documentEntry;
			if (entry.id !== this.activeEntry.get()?.id) {
				void this.openEntry(entry).catch(error => notifications.error(String(error)));
			} else if (entry.content === 'documents') {
				void this.runOperation(() => this.controller.updateDetails(true)).catch(error => notifications.error(String(error)));
			}
		}));
		this._register(toDisposable(() => { for (const key of this.activityKeys.values()) { key.reset(); } }));
	}

	public runOperation(operation: () => Promise<void>): Promise<void> {
		const pending = this.navigationQueue.then(async () => {
			await operation();
			this.saveVisibility();
		});
		this.navigationQueue = pending.catch(error => { this.notifications.error(String(error)); });
		return pending;
	}

	public openEntry(entry: ISessionsEntry, initialize?: () => ISessionsEntry): Promise<void> {
		return this.runOperation(async () => {
			await this.controller.prepareContentChange();
			this.saveVisibility();
			this.isChangingContent = true;
			try {
				if (entry.editorInput) {
					await this.editors.openEditor(entry.editorInput, { pinned: true }, { groupId: this.pageGroupId });
				}
				entry = initialize ? initialize() : entry;
				this.activeEntry.set(entry, undefined);
				if (entry.editorInput) { this.editorEntries.set(extUri.getComparisonKey(entry.editorInput.resource), entry); }
				const productEditor = entry.content === 'editor';
				const documents = entry.content === 'documents';
				const state = this.visibility.get(entry.id) ?? {
					sidebar: true, details: documents || entry.detailsContainerId !== undefined,
					panel: false, documents: documents && this.controller.hasDocumentEditors,
				};
				for (const group of this.editor.groups) { this.editor.setGroupVisible(group.id, (group.id === this.pageGroupId) === productEditor); }
				if (!productEditor) { this.editor.activateGroup(this.editor.groups.find(group => group.id !== this.pageGroupId)!.id); }
				this.layout.updateParts(() => {
					// Hide an outgoing conversation before separating editor details so transient minimum widths cannot shrink navigation.
					if (!productEditor) { this.layout.setPrimaryPart('sessions'); }
					this.layout.setPartAvailable('panel', documents);
					// Optional conversations require a new user action on each entry, including window restoration.
					this.layout.setPartAvailable('sessions', !productEditor);
					if (productEditor) { this.layout.setPrimaryPart('editor'); }
					this.setVisible('editor', productEditor || (documents && state.documents));
					this.setVisible('sidebar', state.sidebar);
					this.setVisible('auxiliarybar', state.details);
					this.setVisible('panel', documents && state.panel);
				});
				await this.views.openViewContainer(entry.sidebarContainerId, entry.focus === 'sidebar');
				this.setVisible('sidebar', state.sidebar);
				if (entry.detailsContainerId) { await this.views.openViewContainer(entry.detailsContainerId); }
				if (documents) { await this.controller.activate(state.details); }
				else { this.setVisible('auxiliarybar', state.details); }
				this.contextKeys.bufferChangeEvents(() => {
					for (const key of this.activityKeys.values()) { key.reset(); }
					let key = this.activityKeys.get(entry.activityContext);
					if (!key) { key = this.contextKeys.createKey(entry.activityContext, false); this.activityKeys.set(entry.activityContext, key); }
					key.set(true);
				});
				this.storage.store(activeEntryKey, entry.restoreCommand, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				if (entry.focus === 'conversation') { this.layout.focus(); }
				else if (entry.focus === 'editor') { this.editors.focusActiveEditor(); }
			} finally { this.isChangingContent = false; this.conversationChanged.fire(); }
		});
	}

	public setConversationVisible(visible: boolean): Promise<void> {
		return this.runOperation(async () => {
			if (this.activeEntry.get()?.conversation !== 'optional') { throw new Error('The active entry does not support a conversation beside its editor.'); }
			this.layout.updateParts(() => this.layout.setPartAvailable('sessions', visible));
			this.conversationChanged.fire();
			if (visible) { this.layout.focus(); }
			else { this.editors.focusActiveEditor(); }
		});
	}

	private setVisible(id: 'sidebar' | 'editor' | 'auxiliarybar' | 'panel', visible: boolean): void {
		if (visible) { this.layout.showPart(id); }
		else { this.layout.hidePart(id); }
	}

	private saveVisibility(): void {
		const entry = this.activeEntry.get();
		if (this.isChangingContent || !entry) { return; }
		this.visibility.set(entry.id, {
			sidebar: this.layout.isPartVisible('sidebar'), details: this.layout.isPartVisible('auxiliarybar'),
			panel: this.layout.isPartVisible('panel'), documents: this.isDocumentContent && this.layout.isPartVisible('editor'),
		});
		this.storage.store(visibilityKey, JSON.stringify(Object.fromEntries(this.visibility)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	public async restore(): Promise<void> {
		await this.controller.whenSettled();
		const saved = this.storage.get(activeEntryKey, StorageScope.WORKSPACE);
		// These names describe the discarded storage format, not runtime product selection.
		const oldEditor = this.storage.get('sessions.layout.primaryEditor', StorageScope.WORKSPACE);
		const oldEntry = this.storage.get('sessions.layout.activeMode', StorageScope.WORKSPACE)
			?? this.storage.get('sessions.layout.primaryPage', StorageScope.WORKSPACE)
			?? this.storage.get('sessions.activityBar.activePage', StorageScope.WORKSPACE)
			?? (oldEditor ? URI.parse(oldEditor).scheme.replace(/^ash-/, '') : undefined);
		const oldCommands: Readonly<Record<string, string>> = {
			chat: 'sessions.open.chat', code: 'sessions.open.code', teams: 'sessions.open.teams', colab: 'sessions.open.teams',
			library: 'sessions.show.library', creator: 'sessions.restore.creator', design: 'sessions.restore.creatorDesign',
		};
		if (!saved && oldEntry !== undefined && !Object.hasOwn(oldCommands, oldEntry)) {
			throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
		}
		await this.commands.executeCommand(saved ?? (oldEntry ? oldCommands[oldEntry]! : 'sessions.open.chat'));
		for (const key of ['sessions.layout.activeMode', 'sessions.layout.primaryPage', 'sessions.activityBar.activePage', 'sessions.layout.primaryEditor']) {
			this.storage.remove(key, StorageScope.WORKSPACE);
		}
	}
}
