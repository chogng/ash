import { ReplAccessibilityProvider, ReplDataSource, ReplOutputElementRenderer } from './replViewer.js';
import { ReplFilter } from './replFilter.js';
import { AsyncDataTree } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { HistoryNavigator } from '../../../../base/common/history.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { EditorCoreCommandId } from '../../../../editor/browser/coreCommands.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Position } from '../../../../editor/common/core/position.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { registerAndCreateHistoryNavigationContext, historyNavigationVisible } from '../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import './media/repl.css';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { DebugConsoleEntry } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getUriFromSource } from '../common/debugSource.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { DEBUG_CONSOLE_VIEW_ID, type IDebugSource } from '../common/debug.js';
import { defaultButtonStyles, defaultFindWidgetStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { FilterViewPane, type IViewPaneOptions, type PartTitleProjection } from '../../../browser/parts/views/viewPane.js';
import { IDebugService, type IDebugSession, type IReplModel, type IDebugCompletionItem, CLEAR_DEBUG_CONSOLE_COMMAND_ID } from '../common/debug.js';

const INPUT_HISTORY_KEY = 'debug.repl.history';
const FILTER_HISTORY_KEY = 'debug.repl.filterHistory';
let replSequence = 0;

/** Panel-owned Debug Console projection for DAP output and REPL evaluation. */
export class Repl extends FilterViewPane {
	private readonly titleActions: ActionBar;
	private readonly sessionSelect: HTMLSelectElement;
	private readonly output: HTMLDivElement;
	private readonly accessibility = new ReplAccessibilityProvider();
	private readonly renderer: ReplOutputElementRenderer;
	private readonly tree;
	private treeRendering = false;
	private treeRenderPending = false;
	private outputFocusToRestore: HTMLElement | undefined;
	private readonly rowTemplates = new WeakMap<HTMLElement, ReturnType<ReplOutputElementRenderer['renderTemplate']>>();
	private renderedSession: string | undefined;
	private readonly contentEmitter = this._register(new Emitter<void>());
	readonly onDidChangeContent = this.contentEmitter.event;
	private readonly filter = new ReplFilter();
	private readonly filterHistory: Set<string>;
	private readonly filterHistoryChanged: Emitter<string[]>;
	private visibleEntries: readonly DebugConsoleEntry[] = [];
	private visibleEntryIds = new Set<number>();
	private filterStats = { total: 0, filtered: 0 };
	private readonly groupOpenBeforeFilter = new Map<number, boolean>();
	private readonly inputModel = this._register(new TextModel('', { languageId: 'debug-repl' }));
	private readonly replInput: CodeEditorWidget;
	private readonly inputHost: HTMLDivElement;
	private readonly inputEditorHost: HTMLDivElement;
	private readonly history = this._register(new HistoryNavigator<string>(new Set(), 100));
	private historyDraft = { value: '', selection: new Selection(1, 1, 1, 1) };
	private navigatingHistory = false;
	private inputHeight = 28;
	private inputBodyHeight: number | undefined;
	private readonly inputLayout = this._register(new RunOnceScheduler(() => this.layoutInput(), 0));
	private readonly suggestions: HTMLDivElement;
	private readonly suggestionItems = this._register(new DisposableStore());
	private readonly completionLifetime = this._register(new MutableDisposable<DisposableStore>());
	private completionRequest: CancellationTokenSource | undefined;
	private readonly completionScheduler = this._register(
		new RunOnceScheduler(() => {
			void this.suggest();
		}, 100),
	);
	private readonly suggestionVisible: IContextKey<boolean>;
	private completionItems: readonly IDebugCompletionItem[] = [];
	private selectedCompletion = 0;
	private completionInput = '';
	private completionCursor = 0;
	private completionSelection = new Selection(1, 1, 1, 1);
	private readonly debugService: IDebugService;
	private readonly form: HTMLFormElement;
	private readonly input: HTMLElement;
	private readonly status: HTMLDivElement;

	private readonly consoleService: IReplModel;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IDebugService debugService: IDebugService,
		@IEditorService private readonly editors: IEditorService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		const filterHistoryChanged = new Emitter<string[]>();
		const filterHistory = Object.assign(new Set(readHistory(storage, logService, FILTER_HISTORY_KEY)), {
			onDidChange: filterHistoryChanged.event,
		});
		super(
			container,
			{
				...options,
				filterOptions: {
					history: filterHistory,
					ariaLabel: localize('debug.repl.filter', 'Filter Debug Console'),
					placeholder: localize('debug.repl.filterPlaceholder', 'Filter (text, !exclude)'),
				},
			},
			instantiation,
		);
		this.filterHistory = filterHistory;
		this.filterHistoryChanged = this._register(filterHistoryChanged);
		this.debugService = debugService;
		this.consoleService = debugService.replModel;
		this.renderer = this._register(
			instantiation.createInstance(
				ReplOutputElementRenderer,
				(entry: DebugConsoleEntry) => this.openSource(entry, entry.source as IDebugSource).catch(error => this.setStatus(message(error))),
				(entry: DebugConsoleEntry) => this.consoleFolder(entry),
			),
		);
		this.contentElement.classList.add('ash-debug-console');
		this.headerActionsElement.classList.add('ash-debug-console-title-actions');
		this.titleActions = this._register(
			new ActionBar(this.headerActionsElement, {
				actionViewItemOptions: { buttonStyles: defaultButtonStyles },
				ariaLabel: localize('debug.repl.actions', 'Debug Console actions'),
			}),
		);
		this.titleActions.element.classList.add('ash-toolbar');
		this.sessionSelect = h(container.ownerDocument, 'select');
		this.sessionSelect.className = 'ash-debug-console-session';
		this.sessionSelect.setAttribute('aria-label', localize('debug.repl.session', 'Debug Console session'));
		this.output = h(container.ownerDocument, 'div');
		this.output.className = 'ash-debug-console-output';
		this.output.setAttribute('role', 'log');
		this.output.setAttribute('aria-label', this.accessibility.getWidgetAriaLabel());
		const dataSource = this.instantiation.createInstance(
			ReplDataSource,
			() => this.consoleService.activeSession?.elements ?? [],
			(entry: DebugConsoleEntry) => this.visibleEntryIds.has(entry.id),
		);
		this.tree = this._register(
			new AsyncDataTree(this.output, dataSource, {
				ariaLabel: this.accessibility.getWidgetAriaLabel(),
				scrolling: 'external',
				reuseRows: true,
				identityProvider: { getId: element => element.id },
				filter: { filter: element => element.entries.some(entry => this.visibleEntryIds.has(entry.id)) },
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: element => this.accessibility.getAriaLabel(element),
				},
				findWidgetStyles: defaultFindWidgetStyles,
				collapseByDefault: element => element.kind !== 'entry' || element.entry.kind !== 'group' || element.entry.collapsed,
				renderElement: element => {
					const template = this.renderer.renderTemplate(h(this.output.ownerDocument, 'div'));
					this.renderer.renderElement(element, 0, template);
					this.rowTemplates.set(template.element, template);
					return template.element;
				},
				onDidRemoveRow: row => {
					const element = row.querySelector<HTMLElement>('.ash-repl-row-content');
					const template = element && this.rowTemplates.get(element);
					if (template) {
						this.renderer.disposeTemplate(template);
						this.rowTemplates.delete(template.element);
					}
				},
			}),
		);
		this._register(
			this.tree.onDidChangeCollapseState(event => {
				this.contentEmitter.fire();
				if (!event.collapsed && event.element.entry.kind === 'group') void this.renderOutput();
			}),
		);
		const loading = this._register(new DisposableMap<unknown, IDisposable>());
		this._register(
			this.tree.onDidChangeLoadState(event => {
				if (event.loading) {
					const progress = this.getProgressIndicator().show(true, 150);
					loading.set(
						event.element,
						toDisposable(() => progress.done()),
					);
				} else {
					loading.deleteAndDispose(event.element);
					this.contentEmitter.fire();
				}
			}),
		);
		this._register(this.tree.onDidError(event => this.setStatus(message(event.error))));
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.DebugConsole);
		if (hint) this.output.setAttribute('aria-description', hint);
		this.form = h(container.ownerDocument, 'form');
		this.form.className = 'ash-debug-console-form';
		const suggestionId = `ash-repl-completions-${++replSequence}`;
		this.inputHost = h(container.ownerDocument, 'div');
		this.inputHost.className = 'ash-repl-input';
		this.inputEditorHost = h(container.ownerDocument, 'div');
		this.inputEditorHost.className = 'ash-repl-input-editor';
		this.inputHost.append(this.inputEditorHost);
		this.form.append(this.inputHost);
		const scope = this._register(contextKeys.createScoped(this.inputHost));
		const editorServices = this._register(instantiation.createChild());
		editorServices.registerInstance(IContextKeyService, scope);
		this.replInput = this._register(
			editorServices.createInstance(CodeEditorWidget, {
				container: this.inputEditorHost,
				model: this.inputModel,
				isSimpleWidget: true,
				dimension: { width: 0, height: this.inputHeight },
				presentation: 'embedded',
				ariaLabel: localize('debug.repl.expression', 'Debug Console expression'),
				placeholder: localize('debug.repl.evaluate', 'Evaluate expression'),
				fontSize: 13,
				lineHeight: 20,
				wordWrap: 'on',
				padding: { top: 4, bottom: 4 },
				lineDecorationsWidth: 0,
				glyphMargin: false,
				folding: false,
				overviewRulerLanes: 0,
				scrollBeyondLastLine: false,
				tabFocusMode: true,
				suggestions: { enabled: false },
				inlineCompletions: { enabled: false },
				contributionIds: [EditorCoreCommandId.selectAll, 'editor.contrib.placeholderText'],
			}),
		);
		this.input = this.replInput.controller.element;
		this.input.setAttribute('aria-controls', suggestionId);
		this.input.setAttribute('aria-autocomplete', 'list');
		this.input.setAttribute('aria-expanded', 'false');
		this.suggestionVisible = historyNavigationVisible.bindTo(scope);
		this._register(toDisposable(() => this.suggestionVisible.reset()));
		const navigation = this._register(
			registerAndCreateHistoryNavigationContext(scope, {
				element: this.inputHost,
				onDidFocus: this.replInput.onDidFocusEditorText,
				onDidBlur: this.replInput.onDidBlurEditorText,
				showPreviousValue: () => this.showPreviousValue(),
				showNextValue: () => this.showNextValue(),
			}),
		);
		const updateHistoryNavigation = (): void => {
			navigation.historyNavigationBackwardsEnablement.set(this.atHistoryBoundary('previous'));
			navigation.historyNavigationForwardsEnablement.set(this.atHistoryBoundary('next'));
		};
		this._register(
			this.replInput.onDidChangeCursorSelection(() => {
				if (!this.replInput.getSelection()?.equalsSelection(this.completionSelection)) this.hideSuggestions();
				updateHistoryNavigation();
			}),
		);
		this._register(
			this.replInput.onDidChangeModelContent(() => {
				this.inputChanged();
				updateHistoryNavigation();
				this.inputLayout.schedule();
			}),
		);
		this._register(this.replInput.onDidContentSizeChange(() => this.inputLayout.schedule()));
		this._register(this.replInput.onDidType(() => this.inputChanged()));
		this._register(this.replInput.onDidPaste(() => this.inputChanged()));
		this._register(this.replInput.onDidCompositionStart(() => this.hideSuggestions()));
		this._register(this.replInput.onDidBlurEditorText(() => this.hideSuggestions()));
		this.restoreInputHistory();
		updateHistoryNavigation();
		this.suggestions = h(container.ownerDocument, 'div');
		this.suggestions.id = suggestionId;
		this.suggestions.className = 'ash-repl-completions';
		this.suggestions.setAttribute('role', 'listbox');
		this.suggestions.setAttribute('aria-label', localize('debug.repl.completions', 'Debug Console suggestions'));
		this.suggestions.hidden = true;
		this.form.append(this.suggestions);
		this.status = h(container.ownerDocument, 'div');
		this.status.className = 'ash-debug-console-status';
		this.status.setAttribute('role', 'status');
		this.contentElement.append(this.sessionSelect, this.output, this.form, this.status);
		this.configureFilter();
		this.trackBodyMinimum(this.output, 60);
		this._register(addDisposableListener(this.sessionSelect, 'change', () => this.selectSession()));
		this._register(
			addDisposableListener(this.form, 'submit', event => {
				event.preventDefault();
				this.acceptReplInput();
			}),
		);
		this._register(addDisposableListener(this.input, 'keydown', event => this.onInputKeyDown(event), true));
		this._register(addDisposableListener(this.output, 'toggle', () => this.contentEmitter.fire(), true));
		this._register(
			addDisposableListener(this.element, 'keydown', event => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
					event.preventDefault();
					event.stopPropagation();
					if (event.altKey) this.openFind();
					else this.focusFilter();
				}
			}),
		);
		this._register(debugService.onDidChangeSession(() => this.hideSuggestions()));
		this._register(debugService.getViewModel().onDidFocusStackFrame(() => this.hideSuggestions()));
		this._register(debugService.getViewModel().onDidFocusThread(() => this.hideSuggestions()));
		this._register(
			storage.onDidChangeValue(event => {
				if (!event.external || event.scope !== StorageScope.WORKSPACE) return;
				if (event.key === INPUT_HISTORY_KEY) {
					this.restoreInputHistory();
					this.hideSuggestions();
				} else if (event.key === FILTER_HISTORY_KEY) {
					this.filterHistory.clear();
					for (const value of this.readHistory(FILTER_HISTORY_KEY)) this.filterHistory.add(value);
					this.filterHistoryChanged.fire([...this.filterHistory]);
				}
			}),
		);
		this._register(this.consoleService.onDidChange(() => this.render()));
		this._register(toDisposable(() => this.hideSuggestions()));
		const observer = new ResizeObserver(() => this.inputLayout.schedule());
		observer.observe(this.inputHost);
		this._register(toDisposable(() => observer.disconnect()));
		this.render();
		this.inputLayout.schedule();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.headerActionsElement };
	}

	private selectSession(): void {
		try {
			this.consoleService.selectSession(this.sessionSelect.value);
		} catch (error) {
			this.setStatus(message(error));
		}
	}

	override focus(): void {
		this.getReplInput().focus();
	}

	getReplInput(): CodeEditorWidget {
		return this.replInput;
	}

	acceptReplInput(): void {
		const expression = this.getReplInput().getValue();
		if (!expression.trim() || this.isReadonly) return;
		this.sendReplInput(expression);
		if (expression.length <= 32_768 && !expression.includes('\0')) {
			this.getReplInput().setValue('');
			this.historyDraft = { value: '', selection: new Selection(1, 1, 1, 1) };
		}
	}

	sendReplInput(input: string): void {
		if (!input.trim() || this.isReadonly) return;
		if (input.length > 32_768 || input.includes('\0')) {
			this.setStatus(localize('debug.repl.invalidExpression', 'Debug Console expression must contain 1 to 32768 characters'));
			return;
		}
		this.hideSuggestions();
		this.history.add(input);
		this.storage.store(INPUT_HISTORY_KEY, JSON.stringify(this.history.getHistory()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		void this.consoleService.evaluate(input).then(
			() => this.setStatus(''),
			error => this.setStatus(message(error)),
		);
	}

	get isReadonly(): boolean {
		return !this.consoleService.activeSession?.canEvaluate;
	}
	getDebugSession(): IDebugSession | undefined {
		const session = this.debugService.session;
		return session?.consoleSessionId === this.consoleService.activeSession?.id ? session : undefined;
	}
	showPreviousValue(): void {
		this.navigateHistory('previous');
	}
	showNextValue(): void {
		this.navigateHistory('next');
	}

	private navigateHistory(direction: 'previous' | 'next'): void {
		if (this.isReadonly) return;
		this.hideSuggestions();
		if (this.history.isNowhere()) {
			if (direction === 'next') return;
			this.historyDraft = { value: this.replInput.getValue(), selection: this.replInput.getSelection()! };
		}
		const value = direction === 'previous' ? this.history.previous() : this.history.next();
		if (value === null && direction === 'previous') return;
		this.navigatingHistory = true;
		try {
			this.replInput.setValue(value ?? this.historyDraft.value);
			if (value === null) this.replInput.setSelection(this.historyDraft.selection);
			else this.replInput.setPosition(direction === 'previous' ? new Position(1, 1) : this.inputModel.getPositionAt(value.length));
		} finally {
			this.navigatingHistory = false;
		}
	}

	private atHistoryBoundary(direction: 'previous' | 'next'): boolean {
		const selection = this.replInput.getSelection();
		const position = this.replInput.getPosition();
		if (!selection?.isEmpty() || !position) return false;
		// Compare rendered lines so wrapped input still permits ordinary caret navigation.
		const line = this.replInput.getTopForPosition(position.lineNumber, position.column);
		const boundary = direction === 'previous' ? new Position(1, 1) : this.inputModel.getPositionAt(this.inputModel.length);
		return line === this.replInput.getTopForPosition(boundary.lineNumber, boundary.column);
	}

	private restoreInputHistory(): void {
		this.history.clear();
		for (const item of this.readHistory(INPUT_HISTORY_KEY)) this.history.add(item);
	}

	private layoutInput(): void {
		const width = this.inputEditorHost.clientWidth;
		if (width <= 0) return;
		this.replInput.layout({ width, height: this.inputHeight });
		const lineHeight = this.replInput.getOption(EditorOption.lineHeight);
		const padding = this.replInput.getOption(EditorOption.padding);
		const minimum = lineHeight + padding.top + padding.bottom;
		const selectStyle = this.inputHost.ownerDocument.defaultView!.getComputedStyle(this.sessionSelect);
		const sessionHeight = this.sessionSelect.hidden ? 0 : this.sessionSelect.offsetHeight + parseFloat(selectStyle.marginTop) + parseFloat(selectStyle.marginBottom);
		// The host sizes around the editor; include its border in the available-height budget.
		const formChrome = this.form.offsetHeight - this.replInput.getDomNode()!.offsetHeight;
		const available = this.inputBodyHeight === undefined ? Infinity : this.inputBodyHeight - 60 - sessionHeight - formChrome - this.status.offsetHeight;
		const maximum = Math.max(minimum, Math.min(lineHeight * 10 + padding.top + padding.bottom, available));
		const height = Math.min(maximum, Math.max(minimum, this.replInput.getBottomForLineNumber(this.inputModel.lineCount) + padding.bottom));
		if (height !== this.inputHeight) {
			this.inputHeight = height;
			this.replInput.layout({ width, height });
		}
	}

	focusFilter(): void {
		const filter = this.getFilterWidget();
		if (!filter.hasFocus()) filter.focus();
	}
	focusTree(): void {
		this.tree.domFocus();
	}
	openFind(): void {
		this.tree.openFind();
	}
	getFilterStats(): { total: number; filtered: number } {
		return { ...this.filterStats };
	}

	protected override layoutBodyContent(height: number, _width: number): void {
		this.inputBodyHeight = height;
		if (this.replInput) this.layoutInput();
	}

	protected override focusBodyContent(): void {
		this.focusTree();
	}

	private readHistory(key: string): string[] {
		return readHistory(this.storage, this.logService, key);
	}

	private configureFilter(): void {
		const widget = this.filterWidget;
		this._register(
			widget.onDidChangeFilterText(query => {
				this.filter.filterQuery = query;
				this.render();
			}),
		);
		this._register(
			widget.onDidAcceptFilterText(() => {
				this.storage.store(FILTER_HISTORY_KEY, JSON.stringify(widget.getHistory()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}),
		);
		this._register(
			addDisposableListener(widget.element, 'keydown', event => {
				if (event.key !== 'Escape' || event.isComposing) return;
				event.preventDefault();
				event.stopPropagation();
				if (widget.getFilterText()) widget.setFilterText('');
				else this.focusTree();
			}),
		);
	}

	private onInputKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || this.replInput.inComposition) return;
		if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space') {
			event.preventDefault();
			event.stopImmediatePropagation();
			void this.suggest();
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
		if (!this.suggestions.hidden && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.key === 'Escape') this.hideSuggestions();
			else if (event.key === 'Enter' || event.key === 'Tab') this.acceptCompletion();
			else {
				this.selectedCompletion = (this.selectedCompletion + (event.key === 'ArrowDown' ? 1 : -1) + this.completionItems.length) % this.completionItems.length;
				this.updateSuggestionSelection();
			}
			return;
		}
		if (
			(event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
			this.atHistoryBoundary(event.key === 'ArrowUp' ? 'previous' : 'next') &&
			(event.key !== 'ArrowDown' || !this.history.isNowhere())
		) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.hideSuggestions();
			if (event.key === 'ArrowUp') this.showPreviousValue();
			else this.showNextValue();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.acceptReplInput();
		} else if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) this.hideSuggestions();
	}

	private inputChanged(): void {
		this.hideSuggestions();
		// Selection notifications can follow the input event. Compare them with
		// this edit's caret so they do not cancel its scheduled completion.
		this.completionInput = this.replInput.getValue();
		this.completionCursor = this.inputModel.getOffsetAt(this.replInput.getPosition()!);
		this.completionSelection = this.replInput.getSelection()!;
		if (!this.navigatingHistory) this.history.reset();
		const session = this.getDebugSession();
		if (this.navigatingHistory || !session?.capabilities.supportsCompletionsRequest) return;
		const prefix = this.replInput.getValue().slice(0, this.completionCursor);
		const last = prefix.at(-1);
		if (last && (/\w/.test(last) || session.capabilities.completionTriggerCharacters.some(trigger => prefix.endsWith(trigger)))) this.completionScheduler.schedule();
	}

	private async suggest(): Promise<void> {
		this.hideSuggestions();
		if (this.isReadonly || !this.replInput.hasTextFocus()) return;
		const session = this.getDebugSession();
		if (!session) return;
		const text = this.replInput.getValue();
		const position = this.replInput.getPosition()!;
		const cursor = this.inputModel.getOffsetAt(position);
		const selection = this.replInput.getSelection()!;
		this.completionSelection = selection;
		this.completionInput = text;
		this.completionCursor = cursor;
		const frame = this.debugService.session === session ? this.debugService.getViewModel().focusedStackFrame : undefined;
		const request = new CancellationTokenSource();
		const lifetime = new DisposableStore();
		lifetime.add(toDisposable(() => request.dispose(true)));
		this.completionLifetime.value = lifetime;
		this.completionRequest = request;
		try {
			const response = await session.completions(frame?.id, frame?.threadId ?? session.threadId ?? 0, text, position, request.token);
			if (
				this.isDisposed ||
				request.token.isCancellationRequested ||
				this.completionRequest !== request ||
				this.replInput.getValue() !== text ||
				!this.replInput.getSelection()?.equalsSelection(selection) ||
				!this.replInput.hasTextFocus() ||
				this.getDebugSession() !== session
			)
				return;
			const prefix = text.slice(0, cursor);
			const history =
				position.lineNumber === 1 && this.inputModel.lineCount === 1
					? this.history
							.getHistory()
							.filter(value => !value.includes('\n') && value.startsWith(prefix) && value !== text)
							.reverse()
							.map(label => ({ label, start: 1, length: text.length }))
					: [];
			const items = [...(response?.body.targets ?? []), ...history];
			const unique = new Map<string, IDebugCompletionItem>();
			for (const item of items) if (!unique.has(item.label)) unique.set(item.label, item);
			this.completionItems = [...unique.values()].sort((a, b) => (a.sortText || a.label).localeCompare(b.sortText || b.label)).slice(0, 100);
			if (!this.completionItems.length) return;
			this.completionInput = text;
			this.completionCursor = cursor;
			this.selectedCompletion = 0;
			this.renderSuggestions();
		} catch (error) {
			if (!this.isDisposed && !request.token.isCancellationRequested) this.setStatus(message(error));
		}
	}

	private renderSuggestions(): void {
		this.suggestionItems.clear();
		this.suggestions.replaceChildren(
			...this.completionItems.map((item, index) => {
				const element = h(this.input.ownerDocument, 'div');
				element.id = `${this.suggestions.id}-${index}`;
				element.className = 'ash-repl-completion';
				element.setAttribute('role', 'option');
				element.textContent = item.label;
				if (item.detail) {
					const detail = h(this.input.ownerDocument, 'span');
					detail.className = 'ash-repl-completion-detail';
					detail.textContent = item.detail;
					element.append(detail);
				}
				this.suggestionItems.add(
					addDisposableListener(element, 'mousedown', event => {
						event.preventDefault();
						this.selectedCompletion = index;
						this.acceptCompletion();
					}),
				);
				return element;
			}),
		);
		this.suggestions.hidden = false;
		this.suggestionVisible.set(true);
		this.input.setAttribute('aria-expanded', 'true');
		this.updateSuggestionSelection();
	}

	private updateSuggestionSelection(): void {
		for (const [index, element] of [...this.suggestions.children].entries()) {
			const selected = index === this.selectedCompletion;
			element.classList.toggle('selected', selected);
			element.setAttribute('aria-selected', String(selected));
		}
		const selected = this.suggestions.children[this.selectedCompletion] as HTMLElement;
		this.input.setAttribute('aria-activedescendant', selected.id);
		selected.scrollIntoView?.({ block: 'nearest' });
	}

	private acceptCompletion(): void {
		const item = this.completionItems[this.selectedCompletion];
		if (!item || this.replInput.getValue() !== this.completionInput || !this.replInput.getSelection()?.equalsSelection(this.completionSelection)) return;
		const position = this.inputModel.getPositionAt(this.completionCursor);
		const start = item.start === undefined ? this.completionCursor : this.inputModel.getOffsetAt(new Position(position.lineNumber, item.start));
		const length = item.length ?? 0;
		const text = item.text || item.label;
		this.hideSuggestions();
		const selection = start + (item.selectionStart ?? text.length);
		const after = this.completionInput.slice(0, start) + text + this.completionInput.slice(start + length);
		this.replInput.pushUndoStop();
		this.replInput.executeEdits('debug.completion', [
			{
				range: Range.fromPositions(this.inputModel.getPositionAt(start), this.inputModel.getPositionAt(start + length)),
				text,
			},
		]);
		// Resolve offsets after applying the edit, including inserted newlines and UTF-16 pairs.
		if (this.replInput.getValue() === after)
			this.replInput.setSelection(Selection.fromPositions(this.inputModel.getPositionAt(selection), this.inputModel.getPositionAt(selection + (item.selectionLength ?? 0))));
		this.replInput.pushUndoStop();
	}

	private hideSuggestions(): void {
		this.completionScheduler.cancel();
		this.completionLifetime.clear();
		this.completionRequest = undefined;
		this.suggestionItems.clear();
		this.completionItems = [];
		this.suggestions.hidden = true;
		this.suggestions.replaceChildren();
		this.input.setAttribute('aria-expanded', 'false');
		this.input.removeAttribute('aria-activedescendant');
		this.suggestionVisible.set(false);
	}

	private render(): void {
		const focused = this.output.ownerDocument.activeElement;
		if (focused instanceof this.output.ownerDocument.defaultView!.HTMLElement && this.output.contains(focused)) this.outputFocusToRestore = focused;
		const active = this.consoleService.activeSession;
		const atEnd = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 8;
		this.sessionSelect.replaceChildren(
			...this.consoleService.sessions.map(session => option(this.element.ownerDocument, session.id, localize('debug.repl.sessionLabel', '{0} — {1}', session.label, session.state))),
		);
		if (active) this.sessionSelect.value = active.id;
		this.sessionSelect.hidden = this.consoleService.sessions.length < 2;
		const entries = active?.elements ?? [];
		const retained = new Set(entries.map(entry => entry.id));
		for (const id of this.groupOpenBeforeFilter.keys()) if (!retained.has(id)) this.groupOpenBeforeFilter.delete(id);
		this.visibleEntries = this.filterEntries(entries);
		this.visibleEntryIds = new Set(this.visibleEntries.map(entry => entry.id));
		this.filterStats = { total: entries.length, filtered: this.visibleEntries.length };
		const stats = this.getFilterStats();
		this.filterWidget.updateBadge(this.filterWidget.getFilterText() ? localize('debug.repl.filterStats', '{0} of {1}', stats.filtered, stats.total) : undefined);
		void this.renderOutput();
		this.replInput.updateOptions({
			readOnly: !active?.canEvaluate,
			placeholder: active?.canEvaluate ? localize('debug.repl.evaluate', 'Evaluate expression') : localize('debug.repl.startToEvaluate', 'Start a debug session to evaluate expressions'),
		});
		if (!active?.canEvaluate) this.hideSuggestions();
		const clearAction: IAction = {
			id: CLEAR_DEBUG_CONSOLE_COMMAND_ID,
			label: localize('debug.repl.clear', 'Clear Console'),
			tooltip: localize('debug.repl.clear', 'Clear Console'),
			icon: Lxicon.clearAll,
			enabled: Boolean(active?.elements.length),
			checked: undefined,
			run: () => this.consoleService.clear(),
		};
		const findAction: IAction = {
			id: 'repl.action.find',
			label: localize('debug.repl.find', 'Find in Debug Console'),
			tooltip: localize('debug.repl.find', 'Find in Debug Console'),
			icon: Lxicon.search,
			enabled: true,
			run: () => this.openFind(),
		};
		this.titleActions.updateActions([findAction, clearAction]);
		if (atEnd) this.output.scrollTop = this.output.scrollHeight;
		this.contentEmitter.fire();
	}

	getVisibleContent(): string {
		return this.tree
			.getVisibleElements()
			.map(element => {
				const text = this.accessibility.getAriaLabel(element);
				return element.kind === 'entry' || text.endsWith('\n') ? text : text + '\n';
			})
			.join('');
	}

	private filterEntries(entries: readonly DebugConsoleEntry[]): readonly DebugConsoleEntry[] {
		const visibility = new Map<number, TreeVisibility>();
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const visible = new Set<number>();
		for (const entry of entries) {
			const parent = entry.parentId === null ? TreeVisibility.Visible : (visibility.get(entry.parentId) ?? TreeVisibility.Visible);
			const result = parent === TreeVisibility.Hidden ? TreeVisibility.Hidden : this.filter.filter(entry, parent);
			const value = result === true || result === TreeVisibility.Visible ? TreeVisibility.Visible : result === TreeVisibility.Recurse ? TreeVisibility.Recurse : TreeVisibility.Hidden;
			visibility.set(entry.id, value);
			if (value !== TreeVisibility.Visible) continue;
			visible.add(entry.id);
			let parentId = entry.parentId;
			while (parentId !== null && byId.has(parentId)) {
				visible.add(parentId);
				parentId = byId.get(parentId)!.parentId;
			}
		}
		return entries.filter(entry => visible.has(entry.id));
	}

	private async renderOutput(): Promise<void> {
		if (this.treeRendering) {
			this.treeRenderPending = true;
			return;
		}
		this.treeRendering = true;
		try {
			do {
				this.treeRenderPending = false;
				const sessionId = this.consoleService.activeSession?.id;
				const atEnd = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 8;
				const filtering = Boolean(this.filterWidget.getFilterText());
				if (sessionId !== this.renderedSession || this.tree.getInput() === undefined) {
					this.groupOpenBeforeFilter.clear();
					this.renderedSession = sessionId;
					await this.tree.setInput(this.consoleService);
				} else await this.tree.updateChildren(this.consoleService, { recursive: false });
				if (this.isDisposed) return;
				const refreshGroups = async (parent: Parameters<typeof this.tree.getNode>[0]): Promise<void> => {
					for (const node of this.tree.getNode(parent).children ?? []) {
						const element = node.element as Awaited<ReturnType<ReplDataSource['getChildren']>>[number];
						if (element.kind !== 'entry' || element.entry.kind !== 'group') continue;
						if (filtering) {
							if (!this.groupOpenBeforeFilter.has(element.entry.id)) this.groupOpenBeforeFilter.set(element.entry.id, this.tree.isCollapsed(element) === false);
							if (this.visibleEntries.some(entry => entry.id === element.entry.id)) await this.tree.expand(element);
						} else if (this.groupOpenBeforeFilter.has(element.entry.id)) {
							if (this.groupOpenBeforeFilter.get(element.entry.id)) await this.tree.expand(element);
							else this.tree.collapse(element);
							this.groupOpenBeforeFilter.delete(element.entry.id);
						}
						// Group membership is already present in the Rust snapshot. Refresh only
						// these branches so streaming never reissues an inspected object's read.
						await this.tree.updateChildren(element, { recursive: false });
						await refreshGroups(element);
					}
				};
				await refreshGroups(this.consoleService);
				if (sessionId !== this.consoleService.activeSession?.id) {
					this.treeRenderPending = true;
					continue;
				}
				if (atEnd) this.output.scrollTop = this.output.scrollHeight;
				this.contentEmitter.fire();
			} while (this.treeRenderPending && !this.isDisposed);
		} catch (error) {
			if (!this.isDisposed) this.setStatus(message(error));
		} finally {
			const focused = this.outputFocusToRestore;
			this.outputFocusToRestore = undefined;
			// Removed source controls return focus to their tree, while a user who
			// moved to the editor or filter during the async refresh keeps that focus.
			if (!this.isDisposed && focused && !focused.isConnected && this.output.ownerDocument.activeElement === this.output.ownerDocument.body) this.tree.domFocus();
			this.treeRendering = false;
		}
	}

	private async openSource(entry: DebugConsoleEntry, source: IDebugSource): Promise<void> {
		const resource = getUriFromSource(source, source.path, entry.sessionId, this.uriIdentity, this.logService);
		await this.editors.openEditor(
			{ resource, label: source.name, readOnly: Boolean(source.sourceReference) },
			{
				selection: new Range(entry.line ?? 1, entry.column ?? 1, entry.line ?? 1, entry.column ?? 1),
			},
		);
	}

	private consoleFolder(entry: DebugConsoleEntry): IWorkspaceFolder | undefined {
		const session = this.debugService.getSession(entry.sessionId);
		if (!session || session.configuration.dirId === null) return undefined;
		const folders = this.workspace.getWorkspace().folders;
		return session.configuration.dirId === undefined ? (folders.length === 1 ? folders[0] : undefined) : folders.find(folder => folder.id === session.configuration.dirId);
	}

	private setStatus(value: string): void {
		this.status.textContent = value;
	}
}

function option(document: Document, value: string, label: string): HTMLOptionElement {
	const element = h(document, 'option');
	element.value = value;
	element.textContent = label;
	return element;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function getReplView(viewsService: IViewsService): Repl | undefined {
	const view = viewsService.getViewWithId(DEBUG_CONSOLE_VIEW_ID);
	return view instanceof Repl ? view : undefined;
}

function readHistory(storage: IStorageService, log: ILogService, key: string): string[] {
	try {
		const value: unknown = JSON.parse(storage.get(key, StorageScope.WORKSPACE, '[]'));
		if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 32_768 || item.includes('\0'))) throw new TypeError('Invalid Debug Console history');
		return value.slice(-100);
	} catch (error) {
		log.warn('Could not restore Debug Console history', error);
		return [];
	}
}
