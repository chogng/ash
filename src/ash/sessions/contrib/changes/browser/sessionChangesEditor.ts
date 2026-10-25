import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import { Dimension, h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import './media/sessionChangesEditor.css';
import { LoadingSkeleton } from '../../../browser/ui/loadingSkeleton.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { EditorPanes } from '../../../../workbench/browser/editor.js';
import { type EditorPaneCreationOptions, EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isEditorPaneWithViewState, type IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import type { MultiDiffEditorInput, MultiDiffEditorInputItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
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
	private skeleton!: LoadingSkeleton;
	private input: IResourceEditorInput | undefined;
	private comparisonInput: MultiDiffEditorInput | undefined;
	private viewState: unknown;
	private dimension: IDimension = Dimension.Zero;
	private visible = false;
	private revision = 0;
	private inputRequest = 0;
	private readonly pending = this._register(new MutableDisposable<IDisposable & { readonly signal: AbortSignal; completion?: Promise<void>; }>());

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
		super(SessionChangesEditor.ID, themeService, storageService);
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
		this.skeleton = this._register(new LoadingSkeleton(this.domNode, localize('sessions.changes.loading', 'Loading changes…'), 'diff', 6));
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		if (this.isDisposed) { throw canceled(); }
		if (this.input && !extUri.isEqual(this.input.resource, input.resource)) {
			this.clearInput();
		}
		this.input = input;
		const inputRequest = ++this.inputRequest;
		let loading = this.refresh(signal);
		for (; ;) {
			const request = this.pending.value;
			try {
				await raceCancellationError(request ? raceCancellationError(loading, request.signal) : loading, signal);
				throwIfCancelled(signal);
				if (inputRequest !== this.inputRequest) { throw canceled(); }
				return;
			} catch (error) {
				const current = this.pending.value;
				// A background refresh belongs to the same open; follow it. A new setInput supersedes the caller.
				if (isCancellationError(error) && !signal.aborted && inputRequest === this.inputRequest && this.visible && current?.completion && current !== request) {
					loading = current.completion;
					continue;
				}
				if (signal.aborted && inputRequest === this.inputRequest) { this.clearInput(); }
				throw error;
			}
		}
	}

	public override clearInput(): void {
		this.inputRequest++;
		this.input = undefined;
		this.comparisonInput = undefined;
		this.viewState = undefined;
		this.revision++;
		this.pending.clear();
		this.comparison.clear();
		this.skeleton?.setVisible(false);
		this.domNode?.setAttribute('aria-busy', 'false');
	}

	public override dispose(): void {
		if (this.isDisposed) { return; }
		this.clearInput();
		super.dispose();
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
		const pane = this.comparison.value;
		if (state != null && pane && isEditorPaneWithViewState(pane)) {
			pane.restoreViewState(state);
		}
		this.viewState = state;
	}

	/** Resolves either comparison side to its current capture; only review actions require the review capability. */
	public async getFileChange(resource: URI, options: { readonly review?: boolean; } = {}): Promise<ISessionFileChange | undefined> {
		const comparison = this.comparisonInput;
		const input = this.input;
		const item = this.findComparisonItem(resource);
		const signal = this.pending.value?.signal;
		if (!this.visible || !input || !comparison || !item || !signal) { return undefined; }
		// A cumulative comparison may start in an earlier Turn; its modified side identifies the capture being reviewed.
		const currentResource = item.modified.resource;
		const id = currentResource.path.split('/')[1];
		if (!id) { return undefined; }
		const sessionResource = new SessionChangesEditorInput(input.resource).sessionResource;
		const selection = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
		const changeset = selection?.kind === 'transient' ? selection.changeset : await raceCancellationError(this.changesService.resolveChangeset(sessionResource, id), signal).catch(error => {
			if (this.isDisposed || !this.visible || this.comparisonInput !== comparison) { return undefined; }
			throw error;
		});
		if (this.isDisposed || this.comparisonInput !== comparison || !changeset?.isEnabled.get() || options.review && !changeset.capabilities?.review) { return undefined; }
		return findChangesEditorFileChange(currentResource, changeset.changes.get());
	}

	public collapse(resource: URI): void { this.setFileCollapsed(resource, true); }
	public expand(resource: URI): void { this.setFileCollapsed(resource, false); }

	private setFileCollapsed(resource: URI, collapsed: boolean): void {
		const item = this.findComparisonItem(resource);
		const pane = this.comparison.value;
		if (!item || !pane || !isEditorPaneWithViewState(pane)) { return; }
		const state = pane.saveViewState() as MultiDiffEditorViewState;
		const ids = new Set(state.collapsedItemIds);
		const id = multiDiffEditorItemKey(item);
		if (collapsed) { ids.add(id); } else { ids.delete(id); }
		pane.restoreViewState({ ...state, collapsedItemIds: [...ids] });
	}

	private findComparisonItem(resource: URI): MultiDiffEditorInputItem | undefined {
		const query = new URLSearchParams(resource.query);
		const modified = query.has('side') ? resource : resource.with({ query: `${resource.query}&side=after` });
		return this.comparisonInput?.items.find(item => extUri.isEqual(item.original.resource, resource) || extUri.isEqual(item.modified.resource, modified));
	}

	private refresh(signal?: AbortSignal): Promise<void> {
		const loading = this.loadChanges(signal);
		if (this.pending.value) { this.pending.value.completion = loading; }
		return loading;
	}

	private async loadChanges(signal?: AbortSignal): Promise<void> {
		const input = this.input;
		if (!input || !this.visible || this.isDisposed) {
			return;
		}
		const revision = ++this.revision;
		// Resolving changes replaces the child pane; keep its snapshot until the new widget can restore it.
		this.viewState = this.saveViewState();
		this.pending.clear();
		this.messageDomNode.hidden = !!this.comparison.value;
		// The old count cannot describe a capture that is still loading or failed to resolve.
		this.changesService.setChangesCount(input.resource, undefined);
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
		this.skeleton.setVisible(!this.comparison.value);
		this.messageDomNode.hidden = true;
		this.domNode.setAttribute('aria-busy', 'true');
		const controller = new AbortController();
		const abortListener = signal ? addDisposableListener(signal, 'abort', () => controller.abort(), { once: true }) : undefined;
		if (signal?.aborted) { controller.abort(); }
		this.pending.value = Object.assign(toDisposable(() => {
			abortListener?.dispose();
			controller.abort();
		}), { signal: controller.signal });
		try {
			const selected = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
			let comparison: MultiDiffEditorInput;
			if (selected?.kind === 'transient') {
				const changes = selected.changeset.isEnabled.get() ? selected.changeset.changes.get() : [];
				if (!changes.length) {
					this.comparison.clear();
					this.comparisonInput = undefined;
					this.messageDomNode.hidden = false;
					this.changesService.setChangesCount(input.resource, 0);
					this.messageDomNode.textContent = localize('sessions.changes.empty', 'No changes in this conversation.');
					return;
				}
				const items = await Promise.all(changes.map(async change => {
					const contents = await raceCancellationError(this.chat.readTurnChangeFile(change.summary.sessionId, change.summary.threadId, change.summary.changeSetId, change.file.path), controller.signal);
					if (contents.truncated && !contents.binary) { throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.')); }
					return {
						label: change.file.path, binary: contents.binary,
						contextKeys: {
							'sessions.changesCanReview': selected.changeset.capabilities?.review === true,
							'sessions.changesCanPreview': change.summary.captureState === 'sealed' && !change.summary.committedPaths.includes(change.file.path) && change.summary.commitState !== 'queued' && change.summary.commitState !== 'committing',
						},
						original: { resource: change.originalUri, initialText: contents.before ?? '', readOnly: true },
						modified: { resource: change.modifiedUri, initialText: contents.after ?? '', readOnly: true }
					};
				}));
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				// File reads target a live capture. Keep their contents paired with the revision supplied by the snapshot.
				const captures = new Map(changes.map(change => [JSON.stringify([change.summary.sessionId, change.summary.threadId, change.summary.changeSetId]), change.summary]));
				await Promise.all([...captures.values()].map(async summary => {
					const current = await raceCancellationError(this.chat.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId), controller.signal);
					if (current.summary.revision !== summary.revision || current.summary.captureState === 'discarded') {
						throw new Error(localize('sessions.changes.captureChanged', 'This Turn capture changed while loading. Reopen its changes to review the latest revision.'));
					}
				}));
				comparison = createMultiDiffEditorInput(input.resource, items, selected.changeset.label, { kind: 'snapshot', label: selected.changeset.label });
			} else {
				const changes = await raceCancellationError(this.chat.listTurnChanges(session.sessionId, threadId), controller.signal);
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				const candidates = selected?.id ? changes.filter(change => change.changeSetId === selected.id) : changes;
				if (!candidates.some(change => change.captureState !== 'discarded' && change.statistics.files > 0)) {
					this.comparison.clear();
					this.comparisonInput = undefined;
					this.messageDomNode.hidden = false;
					this.changesService.setChangesCount(input.resource, 0);
					this.messageDomNode.textContent = localize('sessions.changes.empty', 'No changes in this conversation.');
					return;
				}
				if (selected?.id) { await raceCancellationError(this.changesService.resolveChangeset(new SessionChangesEditorInput(input.resource).sessionResource, selected.id), controller.signal); }
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				comparison = await createTurnMultiDiffEditorInput(this.chat, { session, threadId }, 'throughCurrentTurn', selected?.id ? [selected.id] : undefined, controller.signal);
			}
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			const pane = await EditorPanes.getEditorPane(comparison)!.create({ ...this.options, input: { ...input, editorId: this.id } });
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { pane.dispose(); return; }
			this.comparisonInput = comparison;
			this.comparison.value = pane;
			pane.create(this.domNode);
			// setInput waits for visible diff models, which need a nonzero viewport first.
			pane.layout(this.dimension);
			await raceCancellationError(pane.setInput(comparison, controller.signal), controller.signal);
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			this.messageDomNode.hidden = true;
			this.changesService.setChangesCount(input.resource, comparison.items.length);
			pane.layout(this.dimension);
			// A new conversation starts at the header; cancel deferred first-change
			// navigation just as restoring an existing conversation's state does.
			this.restoreViewState(this.viewState ?? { scrollTop: 0, collapsedItemIds: [], itemViewStates: [] });
			pane.setVisible(true);
		} catch (error) {
			if (!this.isDisposed && revision === this.revision && !controller.signal.aborted) {
				this.changesService.setChangesCount(input.resource, undefined);
				this.messageDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', String(error));
				this.messageDomNode.hidden = false;
			}
		} finally {
			// The caller's open operation ends here; the child pane retains its own controller until hidden or cleared.
			abortListener?.dispose();
			if (!this.isDisposed && revision === this.revision) {
				this.skeleton.setVisible(false);
				this.domNode.setAttribute('aria-busy', 'false');
			}
		}
	}
}
