import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { Dimension, h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import './media/sessionChangesEditor.css';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { EditorPanes } from '../../../../workbench/browser/editor.js';
import { type EditorPaneCreationOptions, EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isEditorPaneWithViewState, type IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import type { MultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';
import type { ISessionFileChange } from '../../../services/sessions/common/session.js';
import { findChangesEditorFileChange } from './changesEditorLabels.js';
import { createMultiDiffEditorInput, multiDiffEditorItemKey } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import type { URI } from '../../../../base/common/uri.js';
import type { MultiDiffEditorViewState } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import type { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';

export const CHANGESET_REVIEW_ACTION_ID = 'changeset.review';

/** Resolves the selected conversation's changes only while its editor content is visible. */
export class SessionChangesEditor extends EditorPane implements IEditorPaneWithViewState {
	public static readonly ID = 'ash.sessions.changesEditor';
	public readonly id = SessionChangesEditor.ID;
	public readonly viewStateTypeId = 'ash.sessions.changesEditor';
	private readonly comparison = this._register(new MutableDisposable<IEditorPane>());
	private domNode!: HTMLDivElement;
	private messageDomNode!: HTMLParagraphElement;
	private input: IResourceEditorInput | undefined;
	private comparisonInput: MultiDiffEditorInput | undefined;
	private viewState: unknown;
	private dimension: IDimension = Dimension.Zero;
	private visible = false;
	private revision = 0;
	private readonly pending = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly options: EditorPaneCreationOptions,
		@IChatService private readonly chat: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionChangesService private readonly changesService: ISessionChangesService,
	) {
		super('ash.sessions.changesEditor', themeService, storageService);
		this._register(chat.onDidUpdateTurnChanges(event => {
			if (this.input?.resource.path === `/${event.sessionId}` && new URLSearchParams(this.input.resource.query).get('thread') === event.threadId) {
				void this.refresh();
			}
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
	}

	public override create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-sessions-changes-editor' });
		this.messageDomNode = h(parent.ownerDocument, 'p', { className: 'ash-sessions-editor-message' });
		this.messageDomNode.setAttribute('role', 'status');
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('aria-label', localize('sessions.changes.title', 'Changes'));
		const context = this._register(this.contextKeys.createScoped(this.domNode));
		context.createKey('sessionsChangesEditorFocused', true);
		const updateHint = (): void => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsChanges);
			if (hint) {
				this.domNode.setAttribute('aria-description', hint);
			} else {
				this.domNode.removeAttribute('aria-description');
			}
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionsChanges)) {
				updateHint();
			}
		}));
		updateHint();
		this.domNode.append(this.messageDomNode);
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		if (this.input && !extUri.isEqual(this.input.resource, input.resource)) {
			this.clearInput();
		}
		this.input = input;
		await this.refresh(signal);
		throwIfCancelled(signal);
	}

	public override clearInput(): void {
		this.input = undefined;
		this.comparisonInput = undefined;
		this.viewState = undefined;
		this.revision++;
		this.pending.clear();
		this.comparison.clear();
	}

	public getAccessibleContent(): string {
		if (!this.comparisonInput) {
			return this.messageDomNode.textContent ?? '';
		}
		return this.comparisonInput.items.map(item => localize('sessions.changes.editorComparison', '{0}\nBefore:\n{1}\nAfter:\n{2}', item.label ?? item.modified.resource.path, item.original.initialText ?? '', item.modified.initialText ?? '')).join('\n\n');
	}

	public override setVisible(visibility: boolean): void {
		if (!visibility && this.visible) {
			this.viewState = this.saveViewState();
		}
		super.setVisible(visibility);
		const visible = visibility;
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (this.visible) {
			void this.refresh();
		} else {
			this.revision++;
			this.pending.clear();
			this.comparison.clear();
			this.comparisonInput = undefined;
		}
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.comparison.value?.layout(dimension);
	}
	public override focus(): void {
		if (this.comparison.value) {
			this.comparison.value.focus();
		} else {
			this.domNode.focus();
		}
	}

	public override getControl(): DiffEditorWidget | undefined {
		return this.comparison.value?.getControl() as DiffEditorWidget | undefined;
	}

	public saveViewState(): unknown {
		const pane = this.comparison.value;
		const state = pane && isEditorPaneWithViewState(pane) ? pane.saveViewState() : undefined;
		return state ?? this.viewState ?? null;
	}

	public restoreViewState(state: unknown): void {
		this.viewState = state;
		const pane = this.comparison.value;
		if (state != null && pane && isEditorPaneWithViewState(pane)) {
			pane.restoreViewState(state);
		}
	}

	public async getFileChange(resource: URI): Promise<ISessionFileChange | undefined> {
		const comparison = this.comparisonInput;
		const input = this.input;
		if (!this.visible || !input || !comparison?.items.some(item => extUri.isEqual(item.original.resource, resource) || extUri.isEqual(item.modified.resource, resource))) { return undefined; }
		const id = resource.path.split('/')[1];
		if (!id) { return undefined; }
		const sessionResource = new SessionChangesEditorInput(input.resource).sessionResource;
		const changeset = await this.changesService.resolveChangeset(sessionResource, id);
		if (this.isDisposed || this.comparisonInput !== comparison || !changeset.isEnabled.get() || !changeset.capabilities?.review) { return undefined; }
		return findChangesEditorFileChange(resource, changeset.changes.get());
	}

	public collapse(resource: URI): void { this.setFileCollapsed(resource, true); }
	public expand(resource: URI): void { this.setFileCollapsed(resource, false); }

	private setFileCollapsed(resource: URI, collapsed: boolean): void {
		const item = this.comparisonInput?.items.find(item => extUri.isEqual(item.original.resource, resource) || extUri.isEqual(item.modified.resource, resource));
		const pane = this.comparison.value;
		if (!item || !pane || !isEditorPaneWithViewState(pane)) { return; }
		const state = pane.saveViewState() as MultiDiffEditorViewState;
		const ids = new Set(state.collapsedItemIds);
		const id = multiDiffEditorItemKey(item);
		if (collapsed) { ids.add(id); } else { ids.delete(id); }
		pane.restoreViewState({ ...state, collapsedItemIds: [...ids] });
	}

	private async refresh(signal?: AbortSignal): Promise<void> {
		const input = this.input;
		if (!input || !this.visible || this.isDisposed) {
			return;
		}
		const revision = ++this.revision;
		// Resolving changes replaces the child pane; keep its snapshot until the new widget can restore it.
		this.viewState = this.saveViewState();
		this.pending.clear();
		this.comparison.clear();
		this.comparisonInput = undefined;
		this.messageDomNode.hidden = false;
		const threadId = new URLSearchParams(input.resource.query).get('thread');
		if (!threadId) {
			this.messageDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			return;
		}
		const session = this.sessions.sessions.find(session => input.resource.path === `/${session.sessionId}`);
		if (!session) {
			return;
		}
		this.messageDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
		const controller = new AbortController();
		const abortListener = signal ? addDisposableListener(signal, 'abort', () => controller.abort(), { once: true }) : undefined;
		if (signal?.aborted) { controller.abort(); }
		this.pending.value = toDisposable(() => {
			abortListener?.dispose();
			controller.abort();
		});
		try {
			const changes = await this.chat.listTurnChanges(session.sessionId, threadId);
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			if (!changes.some(change => change.captureState !== 'discarded' && change.statistics.files > 0)) {
				this.messageDomNode.textContent = localize('sessions.changes.empty', 'No changes in this conversation.');
				return;
			}
			const selected = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
			let comparison: MultiDiffEditorInput;
			if (selected?.kind === 'transient') {
				const items = await Promise.all(selected.changeset.changes.get().map(async change => {
					const contents = await this.chat.readTurnChangeFile(change.summary.sessionId, change.summary.threadId, change.summary.changeSetId, change.file.path);
					if (contents.truncated && !contents.binary) { throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.')); }
					return { label: change.file.path, binary: contents.binary,
						original: { resource: change.originalUri, initialText: contents.before ?? '', readOnly: true },
						modified: { resource: change.modifiedUri, initialText: contents.after ?? '', readOnly: true } };
				}));
				comparison = createMultiDiffEditorInput(input.resource, items, selected.changeset.label, { kind: 'snapshot', label: selected.changeset.label });
			} else {
				if (selected?.id) { await this.changesService.resolveChangeset(new SessionChangesEditorInput(input.resource).sessionResource, selected.id); }
				comparison = await createTurnMultiDiffEditorInput(this.chat, { session, threadId }, 'throughCurrentTurn', selected?.id ? [selected.id] : undefined);
			}
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			const pane = await EditorPanes.getEditorPane(comparison)!.create({ ...this.options, input: { ...input, editorId: this.id } });
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { pane.dispose(); return; }
			this.comparisonInput = comparison;
			this.changesService.setChangesCount(input.resource, comparison.items.length);
			this.comparison.value = pane;
			pane.create(this.domNode);
			// setInput waits for visible diff models, which need a nonzero viewport first.
			pane.layout(this.dimension);
			await pane.setInput(comparison, controller.signal);
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			this.messageDomNode.hidden = true;
			pane.layout(this.dimension);
			// A new conversation starts at the header; cancel deferred first-change
			// navigation just as restoring an existing conversation's state does.
			this.restoreViewState(this.viewState ?? { scrollTop: 0, collapsedItemIds: [], itemViewStates: [] });
			pane.setVisible(true);
		} catch (error) {
			if (!this.isDisposed && revision === this.revision && !controller.signal.aborted) {
				this.messageDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', String(error));
			}
		}
	}
}
