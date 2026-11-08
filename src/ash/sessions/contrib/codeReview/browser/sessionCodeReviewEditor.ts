import { addDisposableListener, Dimension, h, type IDimension } from '../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { readThreadChangesComparison } from '../../../../workbench/contrib/chat/browser/chatEditing/chatEditingActions.js';
import { MultiDiffEditor } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { multiDiffEditorItemKey, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { codeReviewFilePath, codeReviewResource, codeReviewTarget, ISessionCodeReviewService, type CodeReviewComment, type CodeReviewTarget, type SessionCodeReviewService } from './sessionCodeReviewService.js';
import { createReviewSnapshot, SessionCodeReviewWidget, type CodeReviewComparison } from './sessionCodeReviewWidget.js';

type ReviewScope = 'thread' | 'lastTurn';
type ReviewViewMode = 'inline' | 'sideBySide';

export const codeReviewFocusedContext = 'sessionsCodeReviewFocused';

/** A review holds one comparison independently of the conversation's Changes tool. */
export class SessionCodeReviewEditor extends EditorPane implements IEditorPaneWithViewState {
	public static readonly ID = 'ash.sessions.codeReviewEditor';
	public readonly id = SessionCodeReviewEditor.ID;
	public readonly viewStateTypeId = SessionCodeReviewEditor.ID;
	private readonly comparison = this._register(new MutableDisposable<MultiDiffEditor>());
	private readonly loading = this._register(new MutableDisposable());
	private input: IResourceEditorInput | undefined;
	private inputSignal: AbortSignal | undefined;
	private viewMode: ReviewViewMode = 'inline';
	private comparisonInput: MultiDiffEditorInput | undefined;
	private initialComment: CodeReviewComment | undefined;
	private dimension: IDimension = Dimension.Zero;
	private root!: HTMLElement;
	private message!: HTMLElement;
	private workspace!: HTMLElement;
	private diffHost!: HTMLElement;
	private scope!: HTMLSelectElement;
	private files!: HTMLSelectElement;
	private stats!: HTMLElement;
	private seen!: HTMLElement;
	private mode!: HTMLButtonElement;
	private latest!: HTMLButtonElement;
	private saved!: HTMLElement;
	private review!: SessionCodeReviewWidget;

	constructor(
		private readonly openComparison: ((resource: IResourceEditorInput['resource']) => Promise<void>) | undefined,
		@IChatService private readonly chat: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionCodeReviewService private readonly reviews: SessionCodeReviewService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
		@IThemeService themes: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(SessionCodeReviewEditor.ID, themes, storage); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.root = h(document, 'div', { className: 'ash-session-code-review-editor', properties: { tabIndex: 0 } });
		this.root.setAttribute('aria-label', localize('sessions.codeReview.title', 'Code Review'));
		this.message = h(document, 'p', { className: 'ash-session-code-review-message', attributes: { role: 'status' } });
		const notes = h(document, 'aside');
		this.review = this._register(this.instantiation.createInstance(SessionCodeReviewWidget, notes,
			(comment: CodeReviewComment) => this.reveal(comment), this.openComparison));
		this.diffHost = h(document, 'div', { className: 'ash-session-code-review-diff' }, this.message);
		this.workspace = h(document, 'div', { className: 'ash-session-code-review-workspace' }, notes,
			h(document, 'section', { className: 'ash-session-code-review-comparison' }, this.createHeader(document), this.diffHost));
		this.root.append(this.workspace);
		parent.append(this.root);
		super.create(this.root);
		this._register(toDisposable(() => this.root.remove()));
		this._register(this.contexts.createScoped(this.root)).createKey(codeReviewFocusedContext, true);
		this._register(observeElementSize(this.diffHost, () => this.layout(this.dimension)));
		this._register(this.sessions.onDidChange(() => this.review.refresh()));
		this._register(this.reviews.onDidChange(key => {
			const target = this.input && codeReviewTarget(this.input.resource);
			if (target && this.reviews.affects(target, key)) this.updateSeen(target);
		}));
		const updateHint = () => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.DiffEditor);
			if (hint) this.root.setAttribute('aria-description', hint);
			else this.root.removeAttribute('aria-description');
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.DiffEditor)) updateHint();
		}));
		updateHint();
	}

	private createHeader(document: Document): HTMLElement {
		const heading = h(document, 'h2', localize('sessions.codeReview.reviewChanges', 'Review Changes'));
		this.seen = h(document, 'span', { className: 'ash-session-code-review-seen-progress', attributes: { role: 'status' } });
		this.scope = h(document, 'select', {
			className: 'ash-session-code-review-select',
			attributes: { 'aria-label': localize('sessions.codeReview.compare', 'Comparison') },
		}, h(document, 'option', { properties: { value: 'thread' } }, localize('sessions.codeReview.threadChanges', 'Conversation changes')),
			h(document, 'option', { properties: { value: 'lastTurn' } }, localize('sessions.codeReview.lastTurn', 'Last Turn')));
		this.files = h(document, 'select', {
			className: 'ash-session-code-review-select ash-session-code-review-file-picker',
			attributes: { 'aria-label': localize('sessions.codeReview.jumpFile', 'Jump to file') },
		});
		this.stats = h(document, 'span', { className: 'ash-session-code-review-stats', attributes: { role: 'group' } });
		this.saved = h(document, 'span', { className: 'ash-session-code-review-saved-label' }, localize('sessions.codeReview.savedComparison', 'Saved comparison'));
		this.latest = h(document, 'button', {
			className: 'ash-button ash-button-quiet', properties: { type: 'button' },
		}, localize('sessions.codeReview.viewLatest', 'View Latest'));
		this.mode = h(document, 'button', { className: 'ash-button ash-button-quiet', properties: { type: 'button' } });
		this.setViewMode(this.viewMode);
		this._register(addDisposableListener(this.scope, 'change', () => {
			const { input, inputSignal } = this;
			if (!input || !inputSignal) return;
			const scope: ReviewScope = this.scope.value === 'lastTurn' ? 'lastTurn' : 'thread';
			void this.load(input, inputSignal, scope).catch(error => {
				if (this.isDisposed || isCancellationError(error)) return;
				this.message.hidden = false;
				this.message.textContent = localize('sessions.codeReview.loadFailed', 'Could not load this comparison: {0}', String(error));
			});
		}));
		this._register(addDisposableListener(this.files, 'change', () => {
			const item = this.comparisonInput?.items[Number(this.files.value) - 1];
			if (item) {
				this.review.closeComment();
				this.comparison.value?.reveal({ original: item.original.resource, modified: item.modified.resource });
			}
			this.files.value = '';
		}));
		this._register(addDisposableListener(this.latest, 'click', () => {
			const target = this.input && codeReviewTarget(this.input.resource);
			if (target) {
				const resource = codeReviewResource(target);
				const opening = this.openComparison?.(resource)
					?? this.editors.openEditor({ resource }, { pinned: true, revealIfOpened: true, forceReload: true });
				void opening.catch(error => this.notifications.error(error));
			}
		}));
		this._register(addDisposableListener(this.mode, 'click', () => {
			this.setViewMode(this.viewMode === 'inline' ? 'sideBySide' : 'inline');
		}));
		const title = h(document, 'div', { className: 'ash-session-code-review-title' }, heading, this.seen);
		const controls = h(document, 'div', { className: 'ash-session-code-review-controls' },
			this.scope, this.saved, this.stats, this.files, this.mode, this.latest);
		return h(document, 'header', { className: 'ash-session-code-review-header' }, title, controls);
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		await this.load(input, signal, 'thread');
	}

	private async load(input: IResourceEditorInput, signal: AbortSignal, scope: ReviewScope): Promise<void> {
		throwIfCancelled(signal);
		this.clearInput();
		this.input = input;
		this.inputSignal = signal;
		const target = codeReviewTarget(input.resource);
		const history = new URLSearchParams(input.resource.query).get('review') ?? undefined;
		this.workspace.classList.toggle('has-review', !!target);
		this.scope.hidden = !target || !!history;
		this.scope.value = scope;
		this.saved.hidden = !history;
		this.latest.hidden = !history;
		if (!target) {
			this.message.textContent = localize('sessions.codeReview.selectConversation', 'Open a conversation with code changes to start a review.');
			return;
		}
		const state: CodeReviewComparison = {
			target, history,
			isCurrent: () => {
				const active = this.sessions.active;
				return this.isVisible() && this.input === input
					&& active?.session.sessionId === target.sessionId && active.threadId === target.threadId && active.session.status !== 'archived';
			},
			navigationRevision: () => this.sessions.navigationRevision,
		};
		const controller = new AbortController();
		this.loading.value = toDisposable(() => controller.abort());
		const loadingSignal = AbortSignal.any([signal, controller.signal]);
		this.review.setComparison(state);
		this.diffHost.setAttribute('aria-busy', 'true');
		this.message.textContent = localize('sessions.codeReview.loading', 'Loading review…');
		try {
			let comparison: MultiDiffEditorInput | undefined;
			let statistics: { readonly additions: number; readonly deletions: number; } | undefined;
			let turnRepositories: ReadonlyMap<string, string> | undefined;
			if (history) {
				const snapshot = this.review.snapshot(state);
				if (!snapshot?.comments.length) throw new Error(localize('sessions.codeReview.missing', 'This review snapshot is unavailable.'));
				comparison = createReviewSnapshot(input.resource, snapshot);
				this.initialComment = snapshot.comments.find(comment => comment.id === input.resource.fragment) ?? snapshot.comments[0];
			} else if (scope === 'lastTurn') {
				const result = await this.readLastTurn(target, loadingSignal);
				comparison = result?.input;
				statistics = result?.statistics;
				turnRepositories = result?.repositories;
			} else {
				const result = await readThreadChangesComparison(this.chat, target.sessionId, target.threadId, undefined, loadingSignal);
				comparison = result.input;
				statistics = result.summary.statistics;
			}
			throwIfCancelled(loadingSignal);
			if (!comparison?.items.length) {
				this.message.textContent = localize('sessions.codeReview.empty', 'No code changes to review.');
				return;
			}
			const files = comparison.items.map(item => {
				const labelSide = (side: IResourceEditorInput) => ({
					...side, preferredResource: side.resource.with({ path: `/${codeReviewFilePath(side.resource)}`, query: '', fragment: '' }),
				});
				return { ...item, original: labelSide(item.original), modified: labelSide(item.modified) };
			});
			comparison = { ...comparison, items: files };
			const pane = this.comparison.value = this.instantiation.createInstance(MultiDiffEditor, {
				activeEditorId: this.id,
				attachEditor: (item: MultiDiffEditorInputItem, editor: DiffEditorWidget) => this.review.attach(item, editor, turnRepositories),
				viewMode: this.viewMode,
				createFileActions: history ? undefined : (container: HTMLElement, item: MultiDiffEditorInputItem) => this.createSeenCheckbox(container, target, item),
			});
			this.comparisonInput = comparison;
			this.message.hidden = true;
			this.updateFilePicker(comparison);
			this.updateSeen(target);
			if (statistics) this.showStatistics(statistics);
			pane.create(this.diffHost);
			this.layout(this.dimension);
			await pane.setInput(comparison, loadingSignal);
			throwIfCancelled(loadingSignal);
			pane.setVisible(this.isVisible());
			if (!history) {
				const seen = new Set(this.reviews.seenFiles(target));
				for (const item of comparison.items) if (seen.has(multiDiffEditorItemKey(item))) pane.setFileCollapsed(item, true);
			}
			this.revealInitialComment();
		} finally {
			if (!controller.signal.aborted) this.diffHost.removeAttribute('aria-busy');
		}
	}

	public override clearInput(): void {
		this.loading.clear();
		this.input = undefined;
		this.inputSignal = undefined;
		this.comparison.clear();
		this.comparisonInput = undefined;
		this.initialComment = undefined;
		this.review?.setComparison(undefined);
		if (this.message) {
			this.message.hidden = false;
			this.message.textContent = '';
		}
		if (this.root) {
			this.diffHost.removeAttribute('aria-busy');
			this.files.hidden = this.mode.hidden = this.stats.hidden = this.seen.hidden = true;
		}
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (!this.review) return;
		this.comparison.value?.layout(new Dimension(this.diffHost.clientWidth, this.diffHost.clientHeight));
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) this.layout(this.dimension);
		this.comparison.value?.setVisible(visible);
		this.review?.refresh();
		this.revealInitialComment();
	}

	public override focus(): void {
		if (this.comparison.value) this.comparison.value.focus();
		else this.root.focus();
	}

	public saveViewState(): unknown { return this.comparison.value?.saveViewState() ?? null; }
	public restoreViewState(state: unknown): void {
		if (state != null) this.comparison.value?.restoreViewState(state);
	}

	public getAccessibleContent(): string {
		const notes = this.review.snapshot()?.comments.map(comment => comment.text).join('\n');
		const files = this.comparisonInput?.items.map(item => localize('sessions.codeReview.comparison', '{0}\nBefore:\n{1}\nAfter:\n{2}',
			item.label, item.original.initialText ?? '', item.modified.initialText ?? ''));
		return [this.message.hidden ? undefined : this.message.textContent, notes, ...(files ?? [])].filter(Boolean).join('\n\n');
	}

	private setViewMode(mode: ReviewViewMode): void {
		if (this.viewMode !== mode) this.review?.closeComment();
		this.viewMode = mode;
		this.mode.textContent = mode === 'inline'
			? localize('sessions.codeReview.unified', 'Unified')
			: localize('sessions.codeReview.sideBySide', 'Side by side');
		this.mode.setAttribute('aria-label', localize('sessions.codeReview.toggleView', 'Toggle side-by-side diff'));
		this.mode.setAttribute('aria-pressed', String(mode === 'sideBySide'));
		this.comparison.value?.setViewMode(mode);
	}

	private async readLastTurn(target: CodeReviewTarget, signal: AbortSignal) {
		const read = <T>(promise: Promise<T>) => raceCancellationError(promise, signal);
		const { thread } = await read(this.chat.readThread(target.sessionId, target.threadId));
		const turnId = thread.turns.at(-1)?.turnId;
		if (!turnId) return undefined;
		const captures = (await read(this.chat.listTurnChanges(target.sessionId, target.threadId)))
			.filter(capture => capture.turnId === turnId && capture.captureState === 'sealed' && capture.statistics.files > 0);
		if (!captures.length) return undefined;
		const input = await createTurnMultiDiffEditorInput(this.chat, { session: { sessionId: target.sessionId }, threadId: target.threadId }, { turnId }, undefined, signal);
		const statistics = captures.reduce((total, capture) => ({
			additions: total.additions + capture.statistics.additions,
			deletions: total.deletions + capture.statistics.deletions,
		}), { additions: 0, deletions: 0 });
		const repositories = new Map(captures.map(capture => [capture.changeSetId, capture.repositoryId]));
		return { input, statistics, repositories };
	}

	private updateFilePicker(comparison: MultiDiffEditorInput): void {
		const document = this.files.ownerDocument;
		this.files.replaceChildren(h(document, 'option', { properties: { value: '', disabled: true, selected: true } },
			localize('sessions.codeReview.fileCount', '{0} files', comparison.items.length)),
			...comparison.items.map((item, index) => h(document, 'option', { properties: { value: String(index + 1) } }, item.label)));
		this.files.hidden = this.mode.hidden = false;
	}

	private showStatistics(statistics: { readonly additions: number; readonly deletions: number; }): void {
		const document = this.stats.ownerDocument;
		this.stats.replaceChildren(h(document, 'span', { className: 'ash-session-code-review-added' }, `+${statistics.additions}`),
			h(document, 'span', { className: 'ash-session-code-review-removed' }, `−${statistics.deletions}`));
		this.stats.setAttribute('aria-label', localize('sessions.codeReview.statistics', '{0} additions, {1} deletions', statistics.additions, statistics.deletions));
		this.stats.hidden = false;
	}

	private createSeenCheckbox(container: HTMLElement, target: CodeReviewTarget, item: MultiDiffEditorInputItem): IDisposable {
		const resources = new DisposableStore();
		const document = container.ownerDocument;
		const key = multiDiffEditorItemKey(item);
		const checkbox = h(document, 'input', { properties: { type: 'checkbox', checked: this.reviews.seenFiles(target).includes(key) } });
		const label = h(document, 'label', { className: 'ash-session-code-review-seen' }, checkbox, localize('sessions.codeReview.seen', 'Seen'));
		container.append(label);
		resources.add(toDisposable(() => label.remove()));
		resources.add(addDisposableListener(checkbox, 'change', () => {
			this.reviews.setFileSeen(target, key, checkbox.checked);
			this.comparison.value?.setFileCollapsed(item, checkbox.checked);
		}));
		resources.add(this.reviews.onDidChange(changed => {
			if (this.reviews.affects(target, changed)) checkbox.checked = this.reviews.seenFiles(target).includes(key);
		}));
		return resources;
	}

	private updateSeen(target: CodeReviewTarget): void {
		const items = this.comparisonInput?.items;
		if (!items || !this.latest.hidden) { this.seen.hidden = true; return; }
		const seen = new Set(this.reviews.seenFiles(target));
		const count = items.filter(item => seen.has(multiDiffEditorItemKey(item))).length;
		this.seen.textContent = localize('sessions.codeReview.seenProgress', '{0}/{1} seen', count, items.length);
		this.seen.hidden = false;
	}

	private reveal(comment: CodeReviewComment): boolean {
		const pane = this.comparison.value;
		if (!pane || !this.comparisonInput || !this.comparisonInput.items.some(item => multiDiffEditorItemKey(item) === comment.file)) return false;
		if (comment.side === 'original') this.setViewMode('sideBySide');
		return this.review.show(comment, pane, this.comparisonInput);
	}

	private revealInitialComment(): void {
		if (this.initialComment && this.isVisible() && this.reveal(this.initialComment)) this.initialComment = undefined;
	}
}
