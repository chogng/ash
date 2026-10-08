import { MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { addDisposableListener, h, text as createText } from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import type { HistoryInputBox } from "../../../../base/browser/ui/inputbox/inputbox.js";
import { ContextScopedHistoryInputBox } from "../../../../platform/history/browser/contextScopedHistoryWidget.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { SearchResultsRenderer } from "./searchResultsView.js";
import { SearchWidget } from "./searchWidget.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { localize } from "../../../../nls.js";
import { type IContentSearchQuery, type IContentSearchComplete, IContentSearchService } from "../../../../platform/search/common/search.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { WorkbenchObjectTree, type ResourceOpenEvent } from "../../../../platform/list/browser/listService.js";
import { WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { EditorOpenSource, TextEditorSelectionSource } from "../../../../platform/editor/common/editor.js";
import { compressTreeElement, type CompressedTreeNode, type CompressibleTreeElement } from "../../../../base/browser/ui/tree/compressedObjectTreeModel.js";
import type { ObjectTreeElement, ObjectTreeNode } from "../../../../base/browser/ui/tree/objectTreeModel.js";
import { SearchResultImpl, type RenderableMatch, type SearchMatch } from "./searchTreeModel/searchResult.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { AccessibilityVerbositySettingId } from "../../../../platform/accessibility/browser/accessibleView.js";
import { SearchCommandIds, SearchContext } from "../common/constants.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ContentSearchConfiguration } from "../common/searchConfiguration.js";
import { ISearchHistoryService, type ISearchHistoryValues } from "../common/searchHistoryService.js";
import { IReplaceService } from "./replace.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { URI } from "../../../../base/common/uri.js";
import { SearchEditorID } from "../../searchEditor/browser/constants.js";
import { serializeSearchResultForEditor } from "../../searchEditor/browser/searchEditorSerialization.js";
import type { ContextMenuAnchor } from "../../../../base/browser/contextmenu.js";
import { SearchStateKey, SearchUIState } from "../common/search.js";
import type { IAction } from '../../../../base/common/actions.js';

/** Workspace content-search form and incrementally populated result tree. */
export class SearchView extends ViewPane {
	private readonly searchService: IContentSearchService;
	private readonly searchWidget: SearchWidget;
	private readonly historyInputs = new Map<keyof ISearchHistoryValues, HistoryInputBox<boolean>>();
	private get queryInput(): HTMLTextAreaElement { return this.searchWidget.searchInput.inputBox.inputElement; }
	private get replaceInput(): HTMLTextAreaElement { return this.searchWidget.replaceInput.inputBox.inputElement; }
	private resultQuery: IContentSearchQuery | undefined;
	private replaceController: AbortController | undefined;
	private undoReplacement: (() => Promise<void>) | undefined;
	private readonly includeInput: HTMLInputElement;
	private readonly excludeInput: HTMLInputElement;
	private readonly filtersElement: HTMLDivElement;
	private readonly detailsButton: Button;
	private readonly statusElement: HTMLDivElement;
	private readonly resultsElement: HTMLDivElement;
	private readonly tree: WorkbenchObjectTree<RenderableMatch>;
	private readonly resultFocused: IContextKey<boolean>;
	private readonly resourceResultFocused: IContextKey<boolean>;
	private readonly hasSearchResultsKey: IContextKey<boolean>;
	private readonly hasSomeCollapsibleKey: IContextKey<boolean>;
	private readonly hasSearchPatternKey: IContextKey<boolean>;
	private readonly hasReplacePatternKey: IContextKey<boolean>;
	private readonly hasFilePatternKey: IContextKey<boolean>;
	private readonly searchStateKey: IContextKey<SearchUIState>;
	private readonly slowSearchTimer = this._register(new MutableDisposable());
	private readonly resultActions = this._register(new MutableDisposable<WorkbenchToolBar>());
	private primaryResultActions: readonly IAction[] = [];
	private secondaryResultActions: readonly IAction[] = [];
	private readonly resultRenderer: SearchResultsRenderer;
	private readonly resultMenu = this._register(new MutableDisposable());
	private menuElement: RenderableMatch | undefined;
	private result: SearchResultImpl;
	private treeView = false;
	private readonly folderNames = new Map<string, readonly string[]>();
	private sortByCount = false;
	private lastOpenedMatchId: string | undefined;
	private searchController: AbortController | undefined;
	private searchTask: Promise<void> | undefined;
	private searchRevision = 0;
	private searchCompletion: Pick<IContentSearchComplete, "limitHit" | "error"> | undefined;
	private searchCancelled = false;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IContentSearchService searchService: IContentSearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ISearchHistoryService private readonly historyService: ISearchHistoryService,
		@IReplaceService private readonly replaceService: IReplaceService,
		@IDialogService private readonly dialogs: IDialogService,
		@ICommandService private readonly commands: ICommandService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(container, options);
		this.searchService = searchService;
		this.result = new SearchResultImpl(workspaceContext.getWorkspace().folders);
		this.contentElement.classList.add("ash-search");
		const scopedContext = this._register(contextKeyService.createScoped(this.element));
		// The command palette lives outside this pane; its derived flags belong to the window's Search owner.
		this.hasSearchResultsKey = SearchContext.HasSearchResults.bindTo(contextKeyService);
		this.hasSomeCollapsibleKey = SearchContext.ViewHasSomeCollapsibleKey.bindTo(contextKeyService);
		this.hasSearchPatternKey = SearchContext.ViewHasSearchPatternKey.bindTo(contextKeyService);
		this.hasReplacePatternKey = SearchContext.ViewHasReplacePatternKey.bindTo(contextKeyService);
		this.hasFilePatternKey = SearchContext.ViewHasFilePatternKey.bindTo(contextKeyService);
		this.searchStateKey = SearchStateKey.bindTo(contextKeyService);
		this._register(toDisposable(() => {
			this.hasSearchResultsKey.reset(); this.hasSomeCollapsibleKey.reset();
			this.hasSearchPatternKey.reset(); this.hasReplacePatternKey.reset(); this.hasFilePatternKey.reset(); this.searchStateKey.reset();
		}));
		const actionsContext = this._register(contextKeyService.createScoped(this.headerActionsElement));
		const focusKeys = [scopedContext, actionsContext].map(scope => SearchContext.SearchViewFocusedKey.bindTo(scope));
		this._register(this.onDidFocus(() => { for (const key of focusKeys) { key.set(true); } }));
		this._register(this.onDidBlur(() => { for (const key of focusKeys) { key.reset(); } }));
		const document = container.ownerDocument;
		const form = h(document, "form");
		form.className = "ash-search-form";
		// Attach before creating scoped inputs so keyboard commands inherit this pane's context.
		this.contentElement.append(form);
		this.searchWidget = this._register(instantiation.createInstance(SearchWidget, form));
		this.historyInputs.set('search', this.searchWidget.searchInput.inputBox);
		this.historyInputs.set('replace', this.searchWidget.replaceInput.inputBox);
		const detailsRow = h(document, "div");
		detailsRow.className = "ash-search-details-row";
		this.detailsButton = this._register(new Button(detailsRow, {
			label: localize("search.detailsLabel", "Search Details"),
			ariaLabel: localize("search.details", "Toggle Search Details"),
			title: localize("search.details", "Toggle Search Details"),
			icon: Lxicon.chevronRight,
			size: "small",
			onClick: () => this.setDetailsExpanded(this.filtersElement.hidden),
		}));
		const filters = h(document, "div");
		this.filtersElement = filters;
		filters.className = "ash-search-filters";
		form.append(detailsRow, filters);
		filters.id = `ash-search-filters-${options.id}`;
		this.detailsButton.domNode.setAttribute("aria-controls", filters.id);
		const includes = h(document, "label");
		includes.className = "ash-search-filter-field";
		includes.append(createText(document, localize("search.includes", "files to include")));
		filters.append(includes);
		const includeBox = this._register(instantiation.createInstance(ContextScopedHistoryInputBox<false>, includes, {
			presentation: "compact",
			placeholder: localize("search.includesPlaceholder", "e.g. *.ts, src/**/include"),
			ariaLabel: localize("search.includesLabel", "Files to include"),
			history: new Set(historyService.load().include),
		}));
		this.includeInput = includeBox.inputElement;
		const excludes = h(document, "label");
		excludes.className = "ash-search-filter-field";
		excludes.append(createText(document, localize("search.excludes", "files to exclude")));
		filters.append(excludes);
		const excludeBox = this._register(instantiation.createInstance(ContextScopedHistoryInputBox<false>, excludes, {
			presentation: "compact",
			placeholder: localize("search.excludesPlaceholder", "e.g. *.ts, src/**/exclude"),
			ariaLabel: localize("search.excludesLabel", "Files to exclude"),
			history: new Set(historyService.load().exclude),
		}));
		this.excludeInput = excludeBox.inputElement;
		this.historyInputs.set('include', includeBox);
		this.historyInputs.set('exclude', excludeBox);
		this._register(historyService.onDidClearHistory(() => { includeBox.clearHistory(); excludeBox.clearHistory(); }));
		const filterHelp = h(document, 'div');
		filterHelp.className = 'ash-search-filter-help';
		filterHelp.textContent = localize('search.filterHelp', 'Separate glob patterns with commas. Include narrows the search; Exclude omits matching files.');
		filters.append(filterHelp);
		this.applyConfiguration();
		this.setDetailsExpanded(Boolean(this.includeInput.value || this.excludeInput.value));
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-search-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.resultsElement = h(document, "div");
		this.resultsElement.className = "ash-search-results";
		this.contentElement.append(
			form,
			this.statusElement,
			this.resultsElement,
		);
		this.resultRenderer = this._register(instantiation.createInstance(SearchResultsRenderer, document,
			(element: RenderableMatch, anchor: ContextMenuAnchor) => this.showResultContextMenu(element, anchor),
			(element: RenderableMatch) => {
				if (this.menuElement === element) { this.resultMenu.clear(); }
			},
		));
		this.tree = this._register(new WorkbenchObjectTree(this.resultsElement, {
			ariaLabel: localize("search.resultsLabel", "Search results"),
			configurationService,
			scrolling: "managed",
			getHeight: () => 22,
			openOnSingleClick: true,
			multipleSelectionSupport: true,
			expandOnlyOnTwistieClick: true,
			twistieAdditionalCssClass: element => element.kind === "match" ? "ash-tree-twistie-hidden" : undefined,
			modelOptions: { identityProvider: { getId: element => element.id }, defaultCollapseState: "expanded" },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.kind === "match" ? element.preview : this.folderNames.get(element.id)?.join("/") ?? element.name },
			renderElement: element => this.resultRenderer.render(element, {
				treeView: this.treeView,
				folderNames: this.folderNames.get(element.id),
				showWorkspace: this.workspaceContext.getWorkspace().folders.length > 1,
			}),
			onDidRemoveRow: row => this.resultRenderer.releaseRow(row),
		}));
		this.tree.element.setAttribute("aria-busy", "false");
		this.tree.domNode.classList.add("ash-search-results-tree");
		// Scope the shortcut to the tree so deleting text in a query cannot dismiss results.
		const resultContext = this._register(scopedContext.createScoped(this.tree.domNode));
		// Ash lists do not publish listFocus; this tree scope also covers cancellation before the first result.
		SearchContext.SearchResultListFocusedKey.bindTo(resultContext).set(true);
		this.resultFocused = SearchContext.FileMatchOrMatchFocusKey.bindTo(resultContext);
		this.resourceResultFocused = SearchContext.FileMatchOrFolderMatchWithResourceFocusKey.bindTo(resultContext);
		const updateAriaHint = () => {
			const hint = configurationService.getValue<boolean>(AccessibilityVerbositySettingId.Find) ? localize("search.helpHint", "Press Alt+F1 for search accessibility help.") : "";
			this.queryInput.setAttribute("aria-description", hint);
			this.tree.element.setAttribute("aria-description", hint);
		};
		updateAriaHint();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ContentSearchConfiguration.showLineNumbers)) { this.renderResults(); }
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Find)) { updateAriaHint(); }
		}));
		this._register(this.tree.onDidOpen(event => { void this.openResult(event); }));
		this.headerActionsElement.setAttribute('aria-label', localize("search.resultsActions", "Search result actions"));
		this.renderHeaderActions();
		this.updateResultActions();
		this._register(this.tree.onDidChangeFocus(() => this.updateResultActions()));
		this._register(this.tree.onDidChangeSelection(() => this.updateResultActions()));
		this._register(this.tree.onDidChangeCollapseState(() => this.updateResultActions()));
		this._register(this.onDidChangeBodyVisibility(visible => { if (!visible) { this.resultMenu.clear(); } }));
		this._register(addDisposableListener(this.tree.domNode, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.target !== this.tree.element) { return; }
			if (((event.key === "ContextMenu" && !event.shiftKey) || (event.key === "F10" && event.shiftKey)) && this.tree.focus) {
				event.preventDefault();
				event.stopPropagation();
				this.showResultContextMenu(this.tree.focus, this.tree.domNode);
			}
		}));
		this._register(this.searchWidget.onDidChange(() => this.updateResultActions()));
		this._register(this.searchWidget.onSearchSubmit(() => this.triggerQueryChange()));
		this._register(this.searchWidget.onReplaceAll(() => { void this.replaceResults('all', false); }));
		this.searchWidget.layout();
		for (const field of [includeBox, excludeBox]) {
			this._register(field.onDidChange(() => { this.updateFilterSummary(); this.updateResultActions(); }));
		}
		this._register(addDisposableListener(form, "submit", (event) => {
			event.preventDefault();
			this.triggerQueryChange();
		}));
		// Multiple text fields prevent implicit submission; IME confirmation must stay in the input.
		this._register(addDisposableListener(form, "keydown", event => {
			if (event.key === "Enter" && !event.isComposing && (event.target === this.includeInput || event.target === this.excludeInput)) {
				event.preventDefault();
				this.triggerQueryChange();
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (
				event.affectsConfiguration(ContentSearchConfiguration.matchCase) ||
				event.affectsConfiguration(ContentSearchConfiguration.smartCase) ||
				event.affectsConfiguration(ContentSearchConfiguration.regularExpression) ||
				event.affectsConfiguration(ContentSearchConfiguration.includePatterns) ||
				event.affectsConfiguration(ContentSearchConfiguration.excludePatterns)
			) { this.applyConfiguration(); this.updateResultActions(); }
		}));
		this._register(workspaceContext.onDidChangeWorkspace(() => this.clearSearchResults(false)));
		this._register(addDisposableListener(this.contentElement, "keydown", event => {
			if (event.key === "F4") {
				event.preventDefault();
				this.moveMatch(event.shiftKey ? -1 : 1);
			} else if (event.key === "Escape" && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && this.searchController && (event.target === this.queryInput || event.target === this.replaceInput || event.target === this.includeInput || event.target === this.excludeInput)) {
				event.preventDefault();
				this.cancelSearch(false);
			}
		}));
		this._register(toDisposable(() => {
			this.searchController?.abort();
			this.searchController = undefined;
			this.searchTask = undefined;
			this.replaceController?.abort();
			this.result.clear();
		}));
	}

	override focus(): void {
		this.queryInput.focus();
	}

	private setDetailsExpanded(expanded: boolean): void {
		if (!expanded && this.filtersElement.contains(this.element.ownerDocument.activeElement)) {
			this.detailsButton.focus();
		}
		this.filtersElement.hidden = !expanded;
		this.filtersElement.classList.toggle("expanded", expanded);
		this.detailsButton.domNode.setAttribute("aria-expanded", String(expanded));
		this.detailsButton.icon = expanded ? Lxicon.chevronDown : Lxicon.chevronRight;
		this.updateFilterSummary();
	}

	private updateFilterSummary(): void {
		const active = Boolean(this.includeInput.value || this.excludeInput.value);
		this.detailsButton.label = active && this.filtersElement.hidden
			? localize('search.detailsActive', 'Search Details · filters active')
			: localize('search.detailsLabel', 'Search Details');
	}

	private saveHistory(): void {
		const values: ISearchHistoryValues = {};
		for (const [key, input] of this.historyInputs) {
			input.addToHistory();
			values[key] = input.getHistory();
		}
		this.historyService.save(values);
	}

	public triggerQueryChange(options?: { preserveFocus?: boolean; }): void {
		if (this.isDisposed) { return; }
		const text = this.searchWidget.searchInput.inputBox.value;
		if (!text) {
			this.clearSearchResults(false);
			return;
		}
		this.slowSearchTimer.clear();
		const previousController = this.searchController;
		this.saveHistory();
		const AbortControllerConstructor =
			this.element.ownerDocument.defaultView?.AbortController ??
			AbortController;
		const controller = new AbortControllerConstructor();
		this.searchController = controller;
		const revision = ++this.searchRevision;
		this.searchCompletion = undefined;
		this.searchCancelled = false;
		this.result = new SearchResultImpl(this.workspaceContext.getWorkspace().folders);
		const query = this.query(text);
		this.resultQuery = query;
		this.lastOpenedMatchId = undefined;
		this.tree.setChildren([]);
		this.tree.element.setAttribute("aria-busy", "true");
		this.searchStateKey.set(SearchUIState.Searching);
		const ownerWindow = this.element.ownerDocument.defaultView!;
		const timeout = ownerWindow.setTimeout(() => {
			if (!this.isDisposed && revision === this.searchRevision && this.searchController === controller) {
				this.searchStateKey.set(SearchUIState.SlowSearch);
				this.updateResultActions();
			}
		}, 2_000);
		this.slowSearchTimer.value = toDisposable(() => ownerWindow.clearTimeout(timeout));
		this.updateResultActions();
		this.statusElement.textContent = localize("search.searching", "Searching workspace…");
		if (options?.preserveFocus === false) { this.queryInput.focus(); }
		// Publish the new owner before notifying the old provider, which can deliver a final batch synchronously.
		previousController?.abort();
		if (this.isDisposed || revision !== this.searchRevision) { return; }
		// Commands schedule work without waiting; replacement callers await this owner's current task.
		this.searchTask = this.runSearch(query, controller, revision);
	}

	private async runSearch(query: IContentSearchQuery, controller: AbortController, revision: number): Promise<void> {
		try {
			const complete = await this.searchService.search(
				query,
				{
					signal: controller.signal,
					onProgress: (matches) => {
						if (
							this.isDisposed ||
							revision !== this.searchRevision
						) return;
						this.result.add(matches);
						this.renderResults();
						this.statusElement.textContent =
							localize("search.progress", "{0} results…", this.result.count);
					},
				},
			);
			if (this.isDisposed || revision !== this.searchRevision) return;
			this.searchCompletion = complete;
			this.updateSearchResultCount();
		} catch (error) {
			if (
				this.isDisposed ||
				revision !== this.searchRevision ||
				isAbortError(error)
			) return;
			this.searchCompletion = { limitHit: false, error: error instanceof Error ? error.message : localize("search.failed", "Workspace search failed.") };
			this.updateSearchResultCount();
		} finally {
			if (!this.isDisposed && revision === this.searchRevision) {
				this.slowSearchTimer.clear();
				this.tree.element.setAttribute("aria-busy", "false");
				this.searchController = undefined;
				this.searchTask = undefined;
				this.searchStateKey.set(SearchUIState.Idle);
				this.updateResultActions();
			}
		}
	}

	private query(text: string): IContentSearchQuery {
		return {
			text,
			wholeWord: this.searchWidget.wholeWord,
			patternKind: this.searchWidget.useRegex ? "regex" : "literal",
			caseSensitivity: this.searchWidget.matchCase
				? "sensitive"
				: this.configurationValue(ContentSearchConfiguration.smartCase) ? "smart" : "insensitive",
			includePatterns: patterns(this.includeInput.value),
			excludePatterns: patterns(this.excludeInput.value),
			maxResults: this.configurationValue(ContentSearchConfiguration.maxResults),
		};
	}

	private applyConfiguration(): void {
		this.includeInput.value = this.configurationValue(ContentSearchConfiguration.includePatterns);
		this.excludeInput.value = this.configurationValue(ContentSearchConfiguration.excludePatterns);
		this.searchWidget.setQueryOptions(
			this.configurationValue(ContentSearchConfiguration.matchCase),
			this.configurationValue(ContentSearchConfiguration.regularExpression),
		);
		this.updateFilterSummary();
	}

	private configurationValue<T>(key: string): T {
		return this.configurationService.getValue<T>(key);
	}

	public cancelSearch(focus = true): boolean {
		if (this.isDisposed || !this.searchController) { return false; }
		this.slowSearchTimer.clear();
		const controller = this.searchController;
		this.searchController = undefined;
		this.searchTask = undefined;
		// Invalidate callbacks immediately; some providers finish a batch after receiving cancellation.
		this.searchRevision++;
		this.searchCancelled = true;
		this.searchStateKey.set(SearchUIState.Idle);
		this.tree.element.setAttribute("aria-busy", "false");
		this.updateSearchResultCount();
		this.updateResultActions();
		if (focus) { this.queryInput.focus(); }
		controller.abort();
		return true;
	}

	public clearSearchResults(clearInput = true): void {
		if (this.isDisposed) { return; }
		this.slowSearchTimer.clear();
		const replaceController = this.replaceController;
		const searchController = this.searchController;
		this.undoReplacement = undefined;
		this.searchController = undefined;
		this.searchTask = undefined;
		this.searchRevision++;
		this.searchCompletion = undefined;
		this.searchCancelled = false;
		this.searchStateKey.set(SearchUIState.Idle);
		this.result.clear();
		this.resultQuery = undefined;
		this.lastOpenedMatchId = undefined;
		this.tree.setChildren([]);
		this.tree.element.setAttribute("aria-busy", "false");
		this.statusElement.textContent = "";
		if (clearInput) {
			// Repeated clear removes filters only after the query and replacement are already empty.
			const fields = this.searchWidget.searchInput.inputBox.value || this.searchWidget.replaceInput.inputBox.value
				? [this.searchWidget.searchInput.inputBox, this.searchWidget.replaceInput.inputBox]
				: [...this.historyInputs.values()];
			for (const field of fields) {
				field.value = "";
				// Reset input-history navigation, retaining its persisted entries and the selected search options.
				field.resetNavigation();
			}
			this.queryInput.focus();
		}
		this.updateResultActions();
		replaceController?.abort();
		searchController?.abort();
	}

	public getSearchResultSnapshot(): { readonly query: string; readonly content: string; readonly matchCount: number; } | undefined {
		if (this.isDisposed || !this.resultQuery || !this.result.count || this.searchController || this.replaceController) { return undefined; }
		return { query: this.resultQuery.text, content: serializeSearchResultForEditor(this.resultQuery, this.result), matchCount: this.result.count };
	}

	public get searchResult(): SearchResultImpl { return this.result; }

	public getControl(): WorkbenchObjectTree<RenderableMatch> { return this.tree; }

	public async queueRefreshTree(): Promise<void> {
		if (this.isDisposed) { return; }
		this.renderResults();
		this.updateSearchResultCount();
	}

	private updateSearchResultCount(): void {
		if (this.searchCompletion?.error) {
			this.statusElement.textContent = this.searchCompletion.error;
		} else if (this.searchCancelled) {
			this.statusElement.textContent = localize("search.cancelled", "Search stopped. {0} results retained.", this.result.count);
		} else if (this.searchController && !this.searchCompletion) {
			this.statusElement.textContent = localize("search.progress", "{0} results…", this.result.count);
		} else if (!this.result.count) {
			this.statusElement.textContent = localize("search.noResults", "No results found.");
		} else {
			this.statusElement.textContent = this.searchCompletion?.limitHit
				? localize("search.limitReached", "{0} results (result limit reached)", this.result.count)
				: localize("search.results", "{0} results", this.result.count);
		}
	}

	private updateResultActions(): void {
		this.resultFocused.set(this.tree.focus !== undefined && !this.replaceController);
		this.resourceResultFocused.set(this.tree.focus?.kind === "file" || this.tree.focus?.kind === "folder");
		const hasResults = this.result.count > 0;
		const hasSomeCollapsible = this.tree.model.visibleNodes.some(node => node.collapsible && !node.collapsed);
		this.hasSearchResultsKey.set(hasResults);
		this.hasSomeCollapsibleKey.set(hasSomeCollapsible);
		this.hasSearchPatternKey.set(this.searchWidget.searchInput.inputBox.value.length > 0);
		this.hasReplacePatternKey.set(this.searchWidget.replaceInput.inputBox.value.length > 0);
		this.hasFilePatternKey.set(this.includeInput.value.length > 0 || this.excludeInput.value.length > 0);
		const slowSearch = this.searchStateKey.get() === SearchUIState.SlowSearch;
		const showExpandAll = hasResults && !hasSomeCollapsible;
		const canReplace = hasResults && !this.searchController && !this.replaceController;
		this.searchWidget.setReplaceEnabled(canReplace);
		this.primaryResultActions = [
			{
				// Refresh and slow-search cancellation share a slot so keyboard focus survives the transition.
				id: "search.refresh",
				label: slowSearch ? localize("search.cancel", "Cancel Search") : localize("search.refresh", "Refresh search"),
				tooltip: slowSearch ? localize("search.cancel", "Cancel Search") : localize("search.refresh", "Refresh search"),
				icon: slowSearch ? Lxicon.close : Lxicon.refresh,
				enabled: slowSearch || this.searchWidget.searchInput.inputBox.value.length > 0,
				run: () => this.commands.executeCommand(slowSearch ? SearchCommandIds.CancelSearchActionId : SearchCommandIds.RefreshSearchResultsActionId),
			},
			{
				id: "search.clear",
				label: localize("search.clear", "Clear search results"),
				tooltip: localize("search.clear", "Clear search results"),
				icon: Lxicon.trash,
				enabled: Boolean(hasResults || this.hasSearchPatternKey.get() || this.hasReplacePatternKey.get() || this.hasFilePatternKey.get()),
				run: () => this.commands.executeCommand(SearchCommandIds.ClearSearchResultsActionId),
			},
			{
				// Keep the toolbar slot's identity so changing its operation preserves keyboard focus.
				id: "search.collapse",
				label: showExpandAll ? localize("search.expandAll", "Expand All") : localize("search.collapse", "Collapse all results"),
				tooltip: showExpandAll ? localize("search.expandAll", "Expand All") : localize("search.collapse", "Collapse all results"),
				icon: showExpandAll ? Lxicon.chevronDown : Lxicon.chevronUp,
				enabled: hasResults,
				run: () => {
					if (showExpandAll) { return this.commands.executeCommand(SearchCommandIds.ExpandSearchResultsActionId); }
					for (const node of this.tree.model.rootNodes) { this.tree.collapseRecursive(node.id); }
				},
			},
		];
		this.secondaryResultActions = [
			{
				id: SearchCommandIds.CopyMatchCommandId,
				label: localize("search.copy", "Copy"),
				tooltip: "",
				enabled: this.tree.selection.length > 0,
				run: () => this.commands.executeCommand(SearchCommandIds.CopyMatchCommandId),
			},
			{
				id: SearchCommandIds.CopyAllCommandId,
				label: localize("search.copyAll", "Copy All"),
				tooltip: "",
				enabled: hasResults,
				run: () => this.commands.executeCommand(SearchCommandIds.CopyAllCommandId),
			},
			{
				id: SearchCommandIds.RemoveActionId,
				label: localize("search.dismiss", "Dismiss"),
				tooltip: "",
				enabled: this.tree.focus !== undefined && !this.replaceController,
				run: () => this.commands.executeCommand(SearchCommandIds.RemoveActionId),
			},
			{
				id: "search.openEditor",
				label: localize("searchEditor.open", "Open results in Search Editor"),
				tooltip: "",
				enabled: hasResults && !this.searchController,
				run: () => this.editorService.openEditor({
					resource: URI.from({ scheme: 'untitled', path: `/Search-${crypto.randomUUID()}.code-search` }),
					editorId: SearchEditorID,
					label: localize('searchEditor.title', 'Search Editor'),
					showBreadcrumbs: false,
					initialText: serializeSearchResultForEditor(this.resultQuery!, this.result),
				}, { pinned: true }),
			},
			{
				id: "search.replaceSelected",
				label: localize("search.replaceSelected", "Replace selected result"),
				tooltip: "",
				enabled: canReplace && this.tree.focus !== undefined && this.tree.focus.kind !== "folder",
				run: () => this.replaceResults("selected", false),
			},
			{
				id: "search.replacePreview",
				label: localize("search.replacePreview", "Preview replacement"),
				tooltip: "",
				enabled: canReplace,
				run: () => this.replaceResults("all", true),
			},
			{
				id: "search.undoReplacement",
				label: localize("search.undoReplacement", "Undo replacement"),
				tooltip: "",
				enabled: Boolean(this.undoReplacement) && !this.replaceController,
				run: () => this.undoLatestReplacement(),
			},
			{
				id: "search.clearHistory",
				label: localize("search.clearHistory", "Clear search history"),
				tooltip: "",
				enabled: true,
				run: () => this.historyService.clearHistory(),
			},
			{
				id: "search.treeView",
				label: localize("search.treeView", "View as tree"),
				tooltip: "",
				enabled: hasResults,
				checked: this.treeView,
				run: () => { this.treeView = !this.treeView; this.renderResults(); },
			},
			{
				id: "search.sortByCount",
				label: localize("search.sortByCount", "Sort by match count"),
				tooltip: "",
				enabled: hasResults,
				checked: this.sortByCount,
				run: () => { this.sortByCount = !this.sortByCount; this.renderResults(); },
			},
			{
				id: "search.next",
				label: localize("search.next", "Next match (F4)"),
				tooltip: "",
				enabled: hasResults,
				run: () => this.moveMatch(1),
			},
			{
				id: "search.previous",
				label: localize("search.previous", "Previous match (Shift+F4)"),
				tooltip: "",
				enabled: hasResults,
				run: () => this.moveMatch(-1),
			},
		];
		this.resultActions.value?.setActions(this.primaryResultActions, this.secondaryResultActions);
		this.updateTitleArea();
	}

	public override getActions(): readonly IAction[] { return this.primaryResultActions; }
	public override getSecondaryActions(): readonly IAction[] { return this.secondaryResultActions; }

	public override setHeaderVisible(visible: boolean): void {
		super.setHeaderVisible(visible);
		this.renderHeaderActions();
	}

	private renderHeaderActions(): void {
		if (!this.isHeaderVisible()) {
			this.resultActions.clear();
			return;
		}
		if (!this.resultActions.value) {
			this.resultActions.value = new WorkbenchToolBar(this.headerActionsElement, this.contextMenuService, {
				ariaLabel: localize("search.resultsActions", "Search result actions"),
				highlightToggledItems: true,
			});
		}
		this.resultActions.value.setActions(this.primaryResultActions, this.secondaryResultActions);
	}

	private async undoLatestReplacement(): Promise<void> {
		const undo = this.undoReplacement!;
		this.undoReplacement = undefined;
		const controller = new AbortController();
		this.replaceController = controller;
		this.updateResultActions();
		try {
			await undo();
			if (!this.isDisposed && !controller.signal.aborted) { this.triggerQueryChange(); await this.searchTask; }
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted) { this.statusElement.textContent = error instanceof Error ? error.message : String(error); }
		} finally {
			if (!this.isDisposed) { this.replaceController = undefined; this.updateResultActions(); }
		}
	}

	private async replaceResults(scope: "selected" | "all", preview: boolean): Promise<void> {
		if (!this.resultQuery || this.searchController || this.replaceController) { return; }
		const focused = this.tree.focus;
		let matches: readonly SearchMatch[] = [];
		if (scope === "all") { matches = this.result.files.flatMap(file => file.matches); }
		else if (focused?.kind === "match") { matches = [focused]; }
		else if (focused?.kind === "file") { matches = focused.matches; }
		if (!matches.length) { return; }
		const query = this.resultQuery;
		const replacement = this.searchWidget.replaceInput.inputBox.value;
		const controller = new AbortController();
		this.replaceController = controller;
		this.updateResultActions();
		try {
			if (scope === "all" && !preview) {
				const confirmation = await this.dialogs.confirm({
					message: localize("search.replaceConfirm", "Replace {0} matches in {1} files?", matches.length, new Set(matches.map(match => match.file.id)).size),
					primaryButton: localize("search.replaceAll", "Replace All"),
				});
				if (!confirmation.confirmed || controller.signal.aborted || this.isDisposed) { return; }
			}
			this.saveHistory();
			const result = await this.replaceService.replace(matches, query, replacement, { preview, preserveCase: this.searchWidget.preserveCase, signal: controller.signal });
			if (!result.isApplied || this.isDisposed || controller.signal.aborted) { return; }
			this.undoReplacement = result.undo;
			this.triggerQueryChange();
			await this.searchTask;
			if (!this.isDisposed && !controller.signal.aborted && result.saveErrors.length) { this.statusElement.textContent = localize("search.replaceSaveFailed", "Changes were applied, but saving failed: {0}", result.saveErrors.join("; ")); }
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted) { this.statusElement.textContent = error instanceof Error ? error.message : String(error); }
		} finally {
			if (!this.isDisposed) { this.replaceController = undefined; this.updateResultActions(); }
		}
	}

	private renderResults(): void {
		const entries = (elements: readonly RenderableMatch[]): ObjectTreeElement<RenderableMatch>[] => {
			return [...elements].sort((left, right) => {
				if (left.kind === "match" && right.kind === "match") { return left.range.startLineNumber - right.range.startLineNumber || left.range.startColumn - right.range.startColumn; }
				if (left.kind === "folder" && right.kind === "file") { return -1; }
				if (left.kind === "file" && right.kind === "folder") { return 1; }
				if (left.kind === "file" && right.kind === "file") {
					const countOrder = this.sortByCount ? right.matches.length - left.matches.length : 0;
					return countOrder || left.folder.index - right.folder.index || left.path.localeCompare(right.path);
				}
				return left.kind !== "match" && right.kind !== "match" ? left.name.localeCompare(right.name) : 0;
			}).map(element => {
				if (element.kind === "match") { return { element }; }
				const children = element.kind === "file" ? element.matches : [...element.children.values()];
				return { element, children: entries(children) };
			});
		};
		let roots: readonly RenderableMatch[] = this.result.files;
		if (this.treeView) {
			roots = this.result.children.length === 1 ? [...this.result.children[0]!.children.values()] : this.result.children;
		}
		this.resultRenderer.setLineNumberBudget(Math.max(1, ...this.result.files.flatMap(file => file.matches.map(match => match.range.startLineNumber))));
		this.folderNames.clear();
		const treeEntries = entries(roots);
		if (this.treeView) {
			const compressionInput = (entry: ObjectTreeElement<RenderableMatch>): CompressibleTreeElement<RenderableMatch> => ({
				...entry, incompressible: entry.element.kind !== 'folder', children: entry.children?.map(compressionInput),
			});
			const displayNode = (entry: ObjectTreeElement<CompressedTreeNode<RenderableMatch>>): ObjectTreeElement<RenderableMatch> => {
				const elements = entry.element.elements;
				const element = elements.at(-1)!;
				if (elements.length > 1) { this.folderNames.set(element.id, elements.map(folder => folder.kind === 'match' ? '' : folder.name)); }
				return { ...entry, element, children: entry.children?.map(displayNode) };
			};
			const compress = (entry: ObjectTreeElement<RenderableMatch>): ObjectTreeElement<RenderableMatch> => displayNode(compressTreeElement(compressionInput(entry)));
			// Workspace roots keep their separate identities; only directory chains beneath them compress.
			this.tree.setChildren(treeEntries.map(entry => this.result.children.length > 1
				? { ...entry, children: entry.children?.map(compress) }
				: compress(entry)));
		} else {
			this.tree.setChildren(treeEntries);
		}
		this.updateResultActions();
	}

	private moveMatch(direction: number): void {
		const collect = (nodes: readonly ObjectTreeNode<RenderableMatch>[]): SearchMatch[] => nodes.flatMap(node => node.element.kind === "match" ? [node.element] : collect(node.children));
		const matches = collect(this.tree.model.rootNodes);
		if (!matches.length) { return; }
		// Collapsing a file changes tree focus, but next/previous still continues from the last opened match.
		const anchor = this.tree.focus?.kind === "match" ? this.tree.focus.id : this.lastOpenedMatchId;
		const current = matches.findIndex(match => match.id === anchor);
		const first = direction > 0 ? 0 : matches.length - 1;
		const next = matches[current < 0 ? first : (current + direction + matches.length) % matches.length]!;
		this.tree.expandTo(next.id);
		this.tree.setFocus(next.id);
		this.tree.setSelection([next.id]);
		this.tree.domFocus();
		void this.openResult({ element: next, editorOptions: { pinned: false, preserveFocus: true }, sideBySide: false });
	}

	private async openResult(event: Pick<ResourceOpenEvent<RenderableMatch>, "element" | "editorOptions" | "sideBySide">): Promise<void> {
		const element = event.element;
		if (element.kind === "folder") { return; }
		const file = element.kind === "match" ? element.file : element;
		if (element.kind === "match") { this.lastOpenedMatchId = element.id; }
		try {
			await this.editorService.openEditor({ resource: file.resource }, {
				...event.editorOptions,
				source: EditorOpenSource.USER,
				selection: element.kind === "match" ? element.range : undefined,
				selectionSource: TextEditorSelectionSource.NAVIGATION,
				ignoreError: true,
			}, event.sideBySide ? "sideGroup" : "activeGroup");
		} catch (error) {
			if (!this.isDisposed) { this.statusElement.textContent = localize("search.openFailed", "Could not open {0}: {1}", file.path, error instanceof Error ? error.message : String(error)); }
		}
	}

	private showResultContextMenu(element: RenderableMatch, anchor: ContextMenuAnchor): void {
		if (!this.isBodyVisible()) { return; }
		this.resultMenu.clear();
		this.menuElement = element;
		let open = true;
		const lifetime = toDisposable(() => {
			if (open) { open = false; this.contextMenuService.hideContextMenu(); }
			this.menuElement = undefined;
		});
		this.resultMenu.value = lifetime;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => {
				const actions = [{
					id: SearchCommandIds.CopyMatchCommandId,
					label: localize("search.copy", "Copy"),
					tooltip: "",
					enabled: true,
					run: () => this.commands.executeCommand(SearchCommandIds.CopyMatchCommandId, element),
				}];
				if (element.kind !== "match") {
					actions.push({
						id: SearchCommandIds.CopyPathCommandId,
						label: localize("search.copyPath", "Copy Path"),
						tooltip: "",
						enabled: true,
						run: () => this.commands.executeCommand(SearchCommandIds.CopyPathCommandId, element),
					});
				}
				return actions;
			},
			onHide: () => {
				open = false;
				// Desktop close callbacks may arrive after a successor menu has taken ownership.
				if (this.resultMenu.value === lifetime) { this.resultMenu.clear(); }
			},
		});
	}
}

function patterns(value: string): readonly string[] {
	return value
		.split(",")
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0);
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
