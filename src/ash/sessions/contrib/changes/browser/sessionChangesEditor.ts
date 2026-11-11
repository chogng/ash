import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { Dimension, h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import './media/sessionChangesEditor.css';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IChatService, createThreadChangeFileResource } from '../../../../workbench/services/chat/common/chatService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { createTurnChangesSelectionInput, createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import { createThreadMultiDiffEditorInput } from '../../../../workbench/contrib/chat/browser/chatEditing/chatEditingActions.js';
import type { IChangesThreadFileItem } from './changesViewRenderer.js';
import type { MultiDiffEditorInput, MultiDiffEditorInputItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';
import { matchesSessionFileChange, type ISessionFileChange } from '../../../services/sessions/common/session.js';
import { MultiDiffEditor } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import type { URI } from '../../../../base/common/uri.js';
import type { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { ChangesViewPane } from './changesView.js';
import { CHANGES_VIEW_ID } from '../common/changes.js';

interface SessionChangesEditorOptions {
	readonly showChangesView?: boolean;
}

export const CHANGESET_REVIEW_ACTION_ID = 'changeset.review';
export const ChangesFileListAvailableContext = new RawContextKey<boolean>('sessions.changesFileListAvailable', false);
export const ChangesFileListVisibleContext = new RawContextKey<boolean>('sessions.changesFileListVisible', false);

/** Resolves the selected conversation's changes only while its editor content is visible. */
export class SessionChangesEditor extends EditorPane implements IEditorPaneWithViewState {
	public static readonly ID = 'ash.sessions.changesEditor';
	public readonly id = SessionChangesEditor.ID;
	public readonly viewStateTypeId = 'ash.sessions.changesEditor';
	private comparison: MultiDiffEditor | undefined;
	private domNode!: HTMLDivElement;
	private comparisonDomNode!: HTMLElement;
	private detailsDomNode: HTMLElement | undefined;
	private details: ChangesViewPane | undefined;
	private readonly split = this._register(new MutableDisposable<SplitView>());
	private messageDomNode!: HTMLParagraphElement;
	private input: IResourceEditorInput | undefined;
	private comparisonInput: MultiDiffEditorInput | undefined;
	private viewState: unknown;
	private dimension: IDimension = Dimension.Zero;
	private visible = false;
	private detailsFocused = false;
	private detailsVisible = true;
	private turnDetailsVisible = false;
	private revision = 0;
	private inputRequest = 0;
	private readonly pending = this._register(new MutableDisposable<IDisposable & { readonly signal: AbortSignal; completion?: Promise<void>; }>());

	constructor(
		private readonly options: SessionChangesEditorOptions,
		@IChatService private readonly chat: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionChangesService private readonly changesService: ISessionChangesService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(SessionChangesEditor.ID, themeService, storageService);
		this._register(chat.onDidUpdateTurnChanges(event => {
			if (this.input?.resource.path === `/${event.sessionId}` && new URLSearchParams(this.input.resource.query).get('thread') === event.threadId) {
				void this.refresh();
			}
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
		this._register(chat.onDidUpdateThread(event => {
			if (event.update.type !== 'committed' || event.update.event.type !== 'threadHistoryMoved') { return; }
			if (this.input?.resource.path === `/${event.sessionId}` && new URLSearchParams(this.input.resource.query).get('thread') === event.threadId) { void this.refresh(); }
		}));
	}

	public override create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-sessions-changes-editor' });
		this.messageDomNode = h(parent.ownerDocument, 'p', { className: 'ash-sessions-editor-message' });
		this.messageDomNode.setAttribute('role', 'status');
		this.domNode.tabIndex = 0;
		this._register(addDisposableListener(this.domNode, 'focusin', () => {
			this.detailsFocused = this.details?.element.contains(this.domNode.ownerDocument.activeElement) ?? false;
		}));
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
		this.comparisonDomNode = this.options.showChangesView
			? h(parent.ownerDocument, 'div', { className: 'ash-sessions-changes-comparison' }) : this.domNode;
		this.comparisonDomNode.append(this.messageDomNode);
		if (this.options.showChangesView) {
			this.detailsDomNode = h(parent.ownerDocument, 'div', { className: 'ash-sessions-changes-card-details' });
			const scope = this._register(this.instantiation.createChild());
			scope.registerInstance(IContextKeyService, context);
			this.details = this._register(scope.createInstance(ChangesViewPane, this.detailsDomNode, {
				id: CHANGES_VIEW_ID, title: localize('sessions.changes.title', 'Changes'),
			}));
			this.details.setHeaderVisible(false);
			this.details.setVisible(false);
		}
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
		this.turnDetailsVisible = false;
		this.updateFileListVisibility();
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
		this.updateFileListVisibility();
		this.clearComparison();
		this.viewState = undefined;
		this.revision++;
		this.pending.clear();
		this.domNode?.setAttribute('aria-busy', 'false');
	}

	public override dispose(): void {
		if (this.isDisposed) { return; }
		this.clearInput();
		super.dispose();
	}

	public getAccessibleContent(): string {
		if (this.showFileList && this.details && !this.comparisonInput) { return this.details.getAccessibleContent(); }
		if (!this.comparisonInput) {
			return this.messageDomNode.textContent ?? '';
		}
		const comparison = this.comparisonInput.items.map(item => localize('sessions.changes.editorComparison', '{0}\nBefore:\n{1}\nAfter:\n{2}', item.label ?? item.modified.resource.path, item.original.initialText ?? '', item.modified.initialText ?? '')).join('\n\n');
		return [this.showFileList ? this.details?.getAccessibleContent() : undefined, comparison].filter(Boolean).join('\n\n');
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
		this.updateFileListVisibility(true);
		if (this.visible) {
			void this.refresh();
		} else {
			this.revision++;
			this.pending.clear();
			this.clearComparison();
		}
	}

	private get hasThread(): boolean {
		return !!this.input && !!new URLSearchParams(this.input.resource.query).get('thread');
	}

	private get showFileList(): boolean {
		return this.hasThread && (this.isTurnReview ? this.turnDetailsVisible : this.detailsVisible);
	}

	private get isTurnReview(): boolean {
		return this.input instanceof SessionChangesEditorInput && this.input.changesetSelection?.kind === 'turn';
	}

	private updateFileListVisibility(visibilityChanged = false): void {
		this.details?.setVisible(this.visible && this.showFileList);
		// Retained panes share the group context. Only the visible pane publishes its state.
		if (!this.visible && !visibilityChanged) return;
		this.contextKeys.bufferChangeEvents(() => {
			this.contextKeys.setContext(ChangesFileListAvailableContext.key, this.visible && !!this.details && this.hasThread);
			this.contextKeys.setContext(ChangesFileListVisibleContext.key, this.visible && !!this.details && this.showFileList);
		});
	}

	public toggleFileList(): void {
		if (!this.details || !this.hasThread) { return; }
		// A Turn review starts with the captured comparison; the list browses the whole conversation.
		if (this.isTurnReview) this.turnDetailsVisible = !this.turnDetailsVisible;
		else this.detailsVisible = !this.detailsVisible;
		if (!this.showFileList && this.details.element.contains(this.domNode.ownerDocument.activeElement)) {
			this.domNode.focus();
		}
		this.updateFileListVisibility();
		this.layout(this.dimension);
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (!this.details || !this.detailsDomNode) {
			this.comparison?.layout(dimension);
			return;
		}
		const stacked = dimension.width < 720;
		const orientation = stacked ? Orientation.VERTICAL : Orientation.HORIZONTAL;
		if (this.split.value?.orientation !== orientation) {
			this.split.clear();
			const split = new SplitView(this.domNode, { proportionalLayout: false, orientation: orientation });
			this.split.value = split;
			const details = this.details;
			split.addView({
				element: this.comparisonDomNode, minimumSize: stacked ? 120 : 300, maximumSize: Infinity,
				layout: (size, _offset, orthogonalSize) => {
					this.comparison?.layout(new Dimension(stacked ? orthogonalSize : size, stacked ? size : orthogonalSize));
				},
			}, stacked ? Math.max(120, dimension.height * 0.6) : Math.max(300, dimension.width - 240));
			split.addView({
				element: this.detailsDomNode,
				get minimumSize() { return stacked ? details.minimumSize : 220; },
				maximumSize: Infinity,
				onDidChange: details.onDidChange,
				layout: (size, _offset, orthogonalSize) => details.layout(stacked ? size : orthogonalSize, 0, stacked ? orthogonalSize : size),
			}, stacked ? Math.min(300, dimension.height * 0.4) : 240);
		}
		this.split.value!.setViewVisible(1, this.showFileList);
		this.split.value!.layout(stacked ? dimension.height : dimension.width, stacked ? dimension.width : dimension.height);
	}
	public override focus(): void {
		if (this.detailsFocused && this.showFileList && this.details) {
			this.details.focus();
		} else if (this.comparisonInput) {
			this.comparison?.focus();
		} else {
			if (this.showFileList && this.details) { this.details.focus(); } else { this.domNode.focus(); }
		}
	}

	public override getControl(): DiffEditorWidget | undefined {
		return this.comparison?.getControl();
	}

	public saveViewState(): unknown {
		return this.comparison?.saveViewState() ?? this.viewState ?? null;
	}

	public restoreViewState(state: unknown): void {
		if (state != null && this.comparisonInput) {
			this.comparison?.restoreViewState(state);
		}
		this.viewState = state;
	}

	/** Resolves either comparison side to its checkpoint or Turn capture; stale revisions cannot be reviewed. */
	public async getFileChange(resource: URI, options: { readonly review?: boolean; } = {}): Promise<ISessionFileChange | IChangesThreadFileItem | undefined> {
		const comparison = this.comparisonInput;
		const input = this.input;
		const item = this.findComparisonItem(resource);
		const signal = this.pending.value?.signal;
		if (!this.visible || !input || !comparison || !item || !signal) { return undefined; }
		// A cumulative comparison may start in an earlier Turn; its modified side identifies the capture being reviewed.
		const currentResource = item.modified.resource;
		if (currentResource.scheme === 'ash-thread-change') {
			const query = new URLSearchParams(currentResource.query);
			const sessionId = query.get('session')!;
			const threadId = query.get('thread')!;
			const repositoryId = query.get('repository')!;
			const summary = await raceCancellationError(this.chat.readThreadChanges(sessionId, threadId), signal);
			if (this.isDisposed || !this.visible || this.comparisonInput !== comparison || summary.revision !== query.get('revision')) { return undefined; }
			const file = summary.repositories.find(repository => repository.repositoryId === repositoryId)?.files.find(file =>
				extUri.isEqual(currentResource, createThreadChangeFileResource(sessionId, threadId, summary.revision, repositoryId, file.path).with({ query: currentResource.query })));
			if (!file) { return undefined; }
			query.delete('side');
			return {
				type: 'file', id: JSON.stringify([repositoryId, file.path]), sessionId, threadId, repositoryId, revision: summary.revision,
				uri: currentResource.with({ query: query.toString() }), originalUri: item.original.resource, modifiedUri: currentResource,
				file, insertions: file.additions, deletions: file.deletions, warnings: summary.warnings,
			};
		}
		const id = currentResource.path.split('/')[1];
		if (!id) { return undefined; }
		const sessionResource = new SessionChangesEditorInput(input.resource).sessionResource;
		const selection = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
		const changeset = selection?.kind === 'transient' ? selection.changeset : await raceCancellationError(this.changesService.resolveChangeset(sessionResource, id), signal).catch(error => {
			if (this.isDisposed || !this.visible || this.comparisonInput !== comparison) { return undefined; }
			throw error;
		});
		if (this.isDisposed || this.comparisonInput !== comparison || !changeset?.isEnabled.get() || options.review && !changeset.capabilities?.review) { return undefined; }
		return changeset.changes.get().find(change => matchesSessionFileChange(change, currentResource));
	}

	public setFileCollapsed(resource: URI, collapsed: boolean): void {
		const item = this.findComparisonItem(resource);
		if (item) { this.comparison?.setFileCollapsed(item, collapsed); }
	}

	private findComparisonItem(resource: URI): MultiDiffEditorInputItem | undefined {
		const query = new URLSearchParams(resource.query);
		const modified = query.has('side') ? resource : resource.with({ query: `${resource.query}&side=after` });
		return this.comparisonInput?.items.find(item => extUri.isEqual(item.original.resource, resource) || extUri.isEqual(item.modified.resource, resource) || extUri.isEqual(item.modified.resource, modified));
	}

	private clearComparison(): void {
		this.comparisonInput = undefined;
		this.comparison?.setVisible(false);
		this.comparison?.clearInput();
	}

	private showEmptyComparison(resource: URI): void {
		this.clearComparison();
		this.changesService.setChangesCount(resource, 0);
		this.messageDomNode.textContent = localize('sessions.changes.empty', 'No changes in this conversation.');
		this.messageDomNode.hidden = false;
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
		// The shared pane replaces the comparison model and restores this snapshot once it is ready.
		this.viewState = this.saveViewState();
		this.pending.clear();
		this.messageDomNode.hidden = !!this.comparisonInput;
		// The old count cannot describe a capture that is still loading or failed to resolve.
		this.changesService.setChangesCount(input.resource, undefined);
		const threadId = new URLSearchParams(input.resource.query).get('thread');
		if (!threadId) {
			this.messageDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			this.layout(this.dimension);
			return;
		}
		const session = this.sessions.sessions.find(session => input.resource.path === `/${session.sessionId}`);
		if (!session) {
			return;
		}
		this.messageDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
		this.messageDomNode.hidden = false;
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
			if (selected?.kind === 'transient' || selected?.kind === 'turn') {
				const read = <T>(promise: Promise<T>) => raceCancellationError(promise, controller.signal);
				const sessionResource = new SessionChangesEditorInput(input.resource).sessionResource;
				const changesets = selected.kind === 'transient' ? [selected.changeset] : await Promise.all(
					(await read(this.chat.listTurnChanges(session.sessionId, threadId)))
						.filter(capture => capture.turnId === selected.turnId && capture.captureState !== 'discarded' && capture.statistics.files > 0)
						.map(capture => read(this.changesService.resolveChangeset(sessionResource, capture.changeSetId))),
				);
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				const changes = changesets.flatMap(changeset => changeset.isEnabled.get()
					? changeset.changes.get().map(change => ({ change, canReview: changeset.capabilities?.review === true })) : []);
				if (!changes.length) {
					this.showEmptyComparison(input.resource);
					return;
				}
				const label = selected.kind === 'transient' ? selected.changeset.label : localize('sessions.changes.turn', 'Turn {0}', selected.turnId);
				const resource = selected.kind === 'transient' ? input.resource
					: input.resource.with({ scheme: 'ash-multi-diff', fragment: selected.turnId });
				comparison = await createTurnChangesSelectionInput(this.chat, resource, label, changes, controller.signal);
			} else if (!selected?.id) {
				comparison = await createThreadMultiDiffEditorInput(this.chat, session.sessionId, threadId, undefined, controller.signal);
				comparison = { ...comparison, items: comparison.items.map(item => ({ ...item, contextKeys: { ...item.contextKeys, 'sessions.changesCanReview': true } })) };
			} else {
				const changes = await raceCancellationError(this.chat.listTurnChanges(session.sessionId, threadId), controller.signal);
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				const candidates = selected?.id ? changes.filter(change => change.changeSetId === selected.id) : changes;
				if (!candidates.some(change => change.captureState !== 'discarded' && change.statistics.files > 0)) {
					this.showEmptyComparison(input.resource);
					return;
				}
				if (selected?.id) { await raceCancellationError(this.changesService.resolveChangeset(new SessionChangesEditorInput(input.resource).sessionResource, selected.id), controller.signal); }
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				comparison = await createTurnMultiDiffEditorInput(this.chat, { session, threadId }, 'throughCurrentTurn', selected?.id ? [selected.id] : undefined, controller.signal);
			}
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			if (!comparison.items.length) {
				this.showEmptyComparison(input.resource);
				return;
			}
			if (!this.comparison) {
				this.comparison = this._register(this.instantiation.createInstance(MultiDiffEditor, { activeEditorId: this.id }));
				this.comparison.create(this.comparisonDomNode);
				this.comparison.setVisible(false);
			}
			const pane = this.comparison;
			this.layout(this.dimension);
			await raceCancellationError(pane.setInput(comparison, controller.signal), controller.signal);
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			this.comparisonInput = comparison;
			this.messageDomNode.hidden = true;
			this.changesService.setChangesCount(input.resource, comparison.items.length);
			// A new conversation starts at the header; cancel deferred first-change
			// navigation just as restoring an existing conversation's state does.
			this.restoreViewState(this.viewState ?? { scrollTop: 0, collapsedItemIds: [], itemViewStates: [] });
			pane.setVisible(true);
		} catch (error) {
			if (!this.isDisposed && revision === this.revision && !controller.signal.aborted) {
				const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
				// A failed capture cannot keep the previous comparison available for review.
				this.clearComparison();
				this.changesService.setChangesCount(input.resource, undefined);
				this.messageDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', String(error));
				this.messageDomNode.hidden = false;
				if (hadFocus) { this.domNode.focus(); }
			}
		} finally {
			// The caller's open operation ends here; the child pane retains its own controller until hidden or cleared.
			abortListener?.dispose();
			if (!this.isDisposed && revision === this.revision) {
				this.domNode.setAttribute('aria-busy', 'false');
				this.layout(this.dimension);
			}
		}
	}
}
