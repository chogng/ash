import { DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { addDisposableListener, h, text as createText } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import { LabelActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { InputBox } from "../../../../base/browser/ui/inputbox/inputbox.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { localize } from "../../../../nls.js";
import { type IContentSearchQuery, IContentSearchService, type ContentSearchMatchRange } from "../../../../platform/search/common/search.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { WorkbenchObjectTree, type ResourceOpenEvent } from "../../../../platform/list/browser/listService.js";
import { WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IHoverService, type IManagedHover } from "../../../../platform/hover/browser/hoverService.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { EditorOpenSource, TextEditorSelectionSource } from "../../../../platform/editor/common/editor.js";
import type { ObjectTreeElement, ObjectTreeNode } from "../../../../base/browser/ui/tree/objectTreeModel.js";
import { SearchResultImpl, type RenderableMatch, type SearchMatch } from "./searchTreeModel/searchResult.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { AccessibilityVerbositySettingId } from "../../../../platform/accessibility/browser/accessibleView.js";
import { SearchContext } from "../common/constants.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ContentSearchConfiguration } from "../common/searchConfiguration.js";
import { HistoryNavigator } from "../../../../base/common/history.js";
import { ISearchHistoryService, type ISearchHistoryValues } from "../common/searchHistoryService.js";
import { IReplaceService } from "./replace.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { URI } from "../../../../base/common/uri.js";
import { SearchEditorID } from "../../searchEditor/browser/constants.js";
import { serializeSearchResultForEditor } from "../../searchEditor/browser/searchEditorSerialization.js";

/** Workspace content-search form and incrementally populated result tree. */
export class SearchViewPane extends ViewPane {
	private readonly searchService: IContentSearchService;
	private readonly queryInput: HTMLTextAreaElement;
	private caseSensitive = false;
	private wholeWord = false;
	private useRegex = false;
	private preserveCase = false;
	private readonly replaceInput: HTMLInputElement;
	private readonly replaceRow: HTMLDivElement;
	private readonly replaceToggle: Button;
	private readonly replaceActions: ActionBar;
	private readonly histories = new Map<keyof ISearchHistoryValues, HistoryNavigator<string>>();
	private resultQuery: IContentSearchQuery | undefined;
	private replaceController: AbortController | undefined;
	private undoReplacement: (() => Promise<void>) | undefined;
	private readonly queryOptions: ActionBar;
	private readonly includeInput: HTMLInputElement;
	private readonly excludeInput: HTMLInputElement;
	private readonly filtersElement: HTMLDivElement;
	private readonly detailsButton: Button;
	private readonly statusElement: HTMLDivElement;
	private readonly resultsElement: HTMLDivElement;
	private readonly tree: WorkbenchObjectTree<RenderableMatch>;
	private readonly resultActions: WorkbenchToolBar;
	private readonly rowHovers = this._register(new DisposableMap<HTMLElement, IManagedHover>());
	private result: SearchResultImpl;
	private treeView = false;
	private sortByCount = false;
	private lastOpenedMatchId: string | undefined;
	private searchController: AbortController | undefined;
	private searchRevision = 0;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IContentSearchService searchService: IContentSearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ISearchHistoryService private readonly historyService: ISearchHistoryService,
		@IReplaceService private readonly replaceService: IReplaceService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super(container, options);
		this.searchService = searchService;
		this.result = new SearchResultImpl(workspaceContext.getWorkspace().folders);
		this.contentElement.classList.add("ash-search");
		const scopedContext = this._register(contextKeyService.createScoped(this.element));
		const focused = SearchContext.SearchViewFocusedKey.bindTo(scopedContext);
		this._register(addDisposableListener(this.element, "focusin", () => focused.set(true)));
		this._register(addDisposableListener(this.element, "focusout", event => {
			if (!(event.relatedTarget instanceof Node) || !this.element.contains(event.relatedTarget)) { focused.set(false); }
		}));
		const document = container.ownerDocument;
		const form = h(document, "form");
		form.className = "ash-search-form";
		const queryField = h(document, "div");
		queryField.className = "ash-search-query-field";
		this.queryInput = h(document, "textarea");
		this.queryInput.className = "ash-search-query";
		this.queryInput.rows = 1;
		this.queryInput.placeholder = localize("search.query", "Search");
		this.queryInput.setAttribute("aria-label", localize("search.queryLabel", "Search workspace"));
		this.queryInput.spellcheck = false;
		queryField.append(this.queryInput);
		this.queryOptions = this._register(new ActionBar(queryField, {
			ariaLabel: localize("search.options", "Search options"),
			highlightToggledItems: true,
			actionViewItemProvider: action => new LabelActionViewItem(action, {
				label: action.id === "search.matchCase" ? "Aa" : action.id === "search.wholeWord" ? "ab" : ".*",
				ariaLabel: action.label,
			}),
		}));
		this.queryOptions.element.classList.add("ash-search-query-options");
		const queryRow = h(document, "div");
		queryRow.className = "ash-search-query-row";
		this.replaceToggle = this._register(new Button(queryRow, {
			label: localize("search.toggleReplace", "Toggle Replace"),
			icon: Lxicon.chevronRight,
			iconOnly: true,
			size: "small",
			onClick: () => this.setReplaceExpanded(this.replaceRow.hidden),
		}));
		queryRow.append(queryField);
		this.replaceRow = h(document, "div");
		this.replaceRow.className = "ash-search-replace-row";
		this.replaceRow.id = `ash-search-replace-${options.id}`;
		this.replaceToggle.domNode.setAttribute("aria-controls", this.replaceRow.id);
		const replaceField = h(document, "div");
		replaceField.className = "ash-search-replace-field";
		const replaceBox = this._register(new InputBox(replaceField, {
			presentation: "compact",
			placeholder: localize("search.replace", "Replace"),
			ariaLabel: localize("search.replace", "Replace"),
		}));
		this.replaceInput = replaceBox.inputElement;
		this.replaceActions = this._register(new ActionBar(replaceField, {
			ariaLabel: localize("search.replaceActions", "Replacement actions"),
			highlightToggledItems: true,
			actionViewItemProvider: action => action.id === "search.preserveCase" ? new LabelActionViewItem(action, { label: "AB", ariaLabel: action.label }) : undefined,
		}));
		this.replaceRow.append(replaceField);
		form.append(queryRow, this.replaceRow);
		this.setReplaceExpanded(false);
		const detailsRow = h(document, "div");
		detailsRow.className = "ash-search-details-row";
		this.detailsButton = this._register(new Button(detailsRow, {
			label: localize("search.details", "Toggle Search Details"),
			title: localize("search.details", "Toggle Search Details"),
			icon: Lxicon.ellipsis,
			iconOnly: true,
			size: "small",
			onClick: () => this.setDetailsExpanded(this.filtersElement.hidden),
		}));
		const filters = h(document, "div");
		this.filtersElement = filters;
		filters.className = "ash-search-filters";
		filters.id = `ash-search-filters-${options.id}`;
		this.detailsButton.domNode.setAttribute("aria-controls", filters.id);
		const includes = h(document, "label");
		includes.className = "ash-search-filter-field";
		includes.append(createText(document, localize("search.includes", "files to include")));
		const includeBox = this._register(new InputBox(includes, {
			presentation: "compact",
			placeholder: localize("search.includesPlaceholder", "e.g. *.ts, src/**/include"),
			ariaLabel: localize("search.includesLabel", "Files to include"),
		}));
		this.includeInput = includeBox.inputElement;
		const excludes = h(document, "label");
		excludes.className = "ash-search-filter-field";
		excludes.append(createText(document, localize("search.excludes", "files to exclude")));
		const excludeBox = this._register(new InputBox(excludes, {
			presentation: "compact",
			placeholder: localize("search.excludesPlaceholder", "e.g. *.ts, src/**/exclude"),
			ariaLabel: localize("search.excludesLabel", "Files to exclude"),
		}));
		this.excludeInput = excludeBox.inputElement;
		this.bindHistory(this.queryInput, "search");
		this.bindHistory(this.replaceInput, "replace");
		this.bindHistory(this.includeInput, "include");
		this.bindHistory(this.excludeInput, "exclude");
		this._register(historyService.onDidClearHistory(() => { for (const history of this.histories.values()) { history.clear(); } }));
		filters.append(includes, excludes);
		this.applyConfiguration();
		this.setDetailsExpanded(Boolean(this.includeInput.value || this.excludeInput.value));
		form.append(detailsRow, filters);
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
		this.tree = this._register(new WorkbenchObjectTree(this.resultsElement, {
			ariaLabel: localize("search.resultsLabel", "Search results"),
			configurationService,
			scrolling: "managed",
			getHeight: () => 22,
			openOnSingleClick: true,
			multipleSelectionSupport: false,
			expandOnlyOnTwistieClick: true,
			modelOptions: { identityProvider: { getId: element => element.id }, defaultCollapseState: "expanded" },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.kind === "match" ? element.preview : element.name },
			renderElement: element => this.renderResult(element),
			onDidRemoveRow: row => {
				const content = row.querySelector<HTMLElement>(".ash-search-result");
				if (content) { this.rowHovers.deleteAndDispose(content); }
			},
		}));
		this.tree.element.setAttribute("aria-busy", "false");
		this.tree.domNode.classList.add("ash-search-results-tree");
		const updateAriaHint = () => {
			const hint = configurationService.getValue<boolean>(AccessibilityVerbositySettingId.Find) ? localize("search.helpHint", "Press Alt+F1 for search accessibility help.") : "";
			this.queryInput.setAttribute("aria-description", hint);
			this.tree.element.setAttribute("aria-description", hint);
		};
		updateAriaHint();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Find)) { updateAriaHint(); }
		}));
		this._register(this.tree.onDidOpen(event => { void this.openResult(event); }));
		this.resultActions = this._register(new WorkbenchToolBar(this.headerActionsElement, contextMenuService, {
			ariaLabel: localize("search.resultsActions", "Search result actions"),
			highlightToggledItems: true,
		}));
		this.updateResultActions();
		this._register(this.tree.onDidChangeFocus(() => this.updateResultActions()));
		this._register(addDisposableListener(this.queryInput, "input", () => { this.queryInput.rows = Math.min(5, this.queryInput.value.split("\n").length); this.updateResultActions(); }));
		this._register(addDisposableListener(form, "submit", (event) => {
			event.preventDefault();
			void this.startSearch();
		}));
		// Multiple text fields prevent implicit submission; IME confirmation must stay in the input.
		this._register(addDisposableListener(form, "keydown", event => {
			if (event.key === "Enter" && !event.isComposing && !(event.target === this.queryInput && (event.shiftKey || event.altKey)) && (event.target === this.queryInput || event.target === this.includeInput || event.target === this.excludeInput)) {
				event.preventDefault();
				void this.startSearch();
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (
				event.affectsConfiguration(ContentSearchConfiguration.matchCase) ||
				event.affectsConfiguration(ContentSearchConfiguration.smartCase) ||
				event.affectsConfiguration(ContentSearchConfiguration.regularExpression) ||
				event.affectsConfiguration(ContentSearchConfiguration.includePatterns) ||
				event.affectsConfiguration(ContentSearchConfiguration.excludePatterns)
			) this.applyConfiguration();
		}));
		this._register(workspaceContext.onDidChangeWorkspace(() => this.clearResults()));
		this._register(addDisposableListener(this.contentElement, "keydown", event => {
			if (event.key === "F4") {
				event.preventDefault();
				this.moveMatch(event.shiftKey ? -1 : 1);
			} else if (event.key === "Escape" && this.searchController) {
				event.preventDefault();
				this.cancelSearch();
			}
		}));
		this._register(toDisposable(() => {
			this.searchController?.abort();
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
	}

	private setReplaceExpanded(expanded: boolean): void {
		if (!expanded && this.replaceRow.contains(this.element.ownerDocument.activeElement)) { this.queryInput.focus(); }
		this.replaceRow.hidden = !expanded;
		this.replaceRow.classList.toggle("expanded", expanded);
		this.replaceToggle.domNode.setAttribute("aria-expanded", String(expanded));
		this.replaceToggle.domNode.classList.toggle("expanded", expanded);
	}

	private bindHistory(field: HTMLInputElement | HTMLTextAreaElement, key: keyof ISearchHistoryValues): void {
		const history = this._register(new HistoryNavigator(new Set(this.historyService.load()[key]), 100));
		this.histories.set(key, history);
		let draft = "";
		let navigating = false;
		this._register(addDisposableListener(field, "input", () => { navigating = false; history.reset(); }));
		this._register(addDisposableListener(field, "keydown", event => {
			if (event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) { return; }
			if (field === this.queryInput && field.value.includes("\n") && !event.altKey) { return; }
			if (event.key === "ArrowDown" && !navigating) { return; }
			event.preventDefault();
			if (!navigating) { draft = field.value; history.reset(); }
			const value = event.key === "ArrowUp" ? history.previous() : history.next();
			if (value === null && event.key === "ArrowUp") { return; }
			field.value = value ?? draft;
			navigating = value !== null;
			field.setSelectionRange(field.value.length, field.value.length);
			this.queryInput.rows = Math.min(5, this.queryInput.value.split("\n").length);
			this.updateResultActions();
		}));
	}

	private saveHistory(): void {
		const values: ISearchHistoryValues = {};
		for (const [key, field] of [["search", this.queryInput], ["replace", this.replaceInput], ["include", this.includeInput], ["exclude", this.excludeInput]] as const) {
			const history = this.histories.get(key)!;
			if (field.value) { history.add(field.value); }
			values[key] = history.getHistory();
		}
		this.historyService.save(values);
	}

	private updateQueryOptions(): void {
		this.queryOptions.setActions([
			{
				id: "search.matchCase",
				label: localize("search.matchCase", "Match Case"),
				tooltip: localize("search.matchCase", "Match Case"),
				enabled: true,
				checked: this.caseSensitive,
				run: () => {
					this.caseSensitive = !this.caseSensitive;
					this.updateQueryOptions();
				},
			},
			{
				id: "search.wholeWord",
				label: localize("search.wholeWord", "Match Whole Word"),
				tooltip: localize("search.wholeWord", "Match Whole Word"),
				enabled: true,
				checked: this.wholeWord,
				run: () => { this.wholeWord = !this.wholeWord; this.updateQueryOptions(); },
			},
			{
				id: "search.useRegex",
				label: localize("search.useRegex", "Use Regular Expression"),
				tooltip: localize("search.useRegex", "Use Regular Expression"),
				enabled: true,
				checked: this.useRegex,
				run: () => {
					this.useRegex = !this.useRegex;
					this.updateQueryOptions();
				},
			},
		]);
	}

	private async startSearch(): Promise<void> {
		const text = this.queryInput.value;
		if (!text) {
			this.statusElement.textContent = localize("search.enterQuery", "Enter text to search.");
			this.queryInput.focus();
			return;
		}
		this.searchController?.abort();
		this.saveHistory();
		const AbortControllerConstructor =
			this.element.ownerDocument.defaultView?.AbortController ??
			AbortController;
		const controller = new AbortControllerConstructor();
		this.searchController = controller;
		const revision = ++this.searchRevision;
		this.result = new SearchResultImpl(this.workspaceContext.getWorkspace().folders);
		this.resultQuery = this.query(text);
		this.lastOpenedMatchId = undefined;
		this.tree.setChildren([]);
		this.tree.element.setAttribute("aria-busy", "true");
		this.updateResultActions();
		this.statusElement.textContent = localize("search.searching", "Searching workspace…");
		try {
			const complete = await this.searchService.search(
				this.resultQuery,
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
			if (complete.error) {
				this.statusElement.textContent = complete.error;
			} else if (complete.resultCount === 0) {
				this.statusElement.textContent = localize("search.noResults", "No results found.");
			} else {
				this.statusElement.textContent =
					complete.limitHit
						? localize("search.limitReached", "{0} results (result limit reached)", this.result.count)
						: localize("search.results", "{0} results", this.result.count);
			}
		} catch (error) {
			if (
				this.isDisposed ||
				revision !== this.searchRevision ||
				isAbortError(error)
			) return;
			this.statusElement.textContent = error instanceof Error
				? error.message
				: localize("search.failed", "Workspace search failed.");
		} finally {
			if (!this.isDisposed && revision === this.searchRevision) {
				this.tree.element.setAttribute("aria-busy", "false");
				this.searchController = undefined;
				this.updateResultActions();
			}
		}
	}

	private query(text: string): IContentSearchQuery {
		return {
			text,
			wholeWord: this.wholeWord,
			patternKind: this.useRegex ? "regex" : "literal",
			caseSensitivity: this.caseSensitive
				? "sensitive"
				: this.configurationValue(ContentSearchConfiguration.smartCase) ? "smart" : "insensitive",
			includePatterns: patterns(this.includeInput.value),
			excludePatterns: patterns(this.excludeInput.value),
			maxResults: this.configurationValue(ContentSearchConfiguration.maxResults),
		};
	}

	private applyConfiguration(): void {
		this.caseSensitive = this.configurationValue(ContentSearchConfiguration.matchCase);
		this.useRegex = this.configurationValue(ContentSearchConfiguration.regularExpression);
		this.includeInput.value = this.configurationValue(ContentSearchConfiguration.includePatterns);
		this.excludeInput.value = this.configurationValue(ContentSearchConfiguration.excludePatterns);
		this.updateQueryOptions();
	}

	private configurationValue<T>(key: string): T {
		return this.configurationService.getValue<T>(key);
	}

	private cancelSearch(): void {
		this.searchController?.abort();
		this.searchController = undefined;
		// Invalidate callbacks immediately; some providers finish a batch after receiving cancellation.
		this.searchRevision++;
		this.tree.element.setAttribute("aria-busy", "false");
		this.statusElement.textContent = localize("search.cancelled", "Search stopped. {0} results retained.", this.result.count);
		this.updateResultActions();
	}

	private clearResults(): void {
		this.replaceController?.abort();
		this.undoReplacement = undefined;
		this.searchController?.abort();
		this.searchController = undefined;
		this.searchRevision++;
		this.result.clear();
		this.resultQuery = undefined;
		this.lastOpenedMatchId = undefined;
		this.tree.setChildren([]);
		this.tree.element.setAttribute("aria-busy", "false");
		this.statusElement.textContent = "";
		this.updateResultActions();
		this.queryInput.focus();
	}

	private updateResultActions(): void {
		const hasResults = this.result.count > 0;
		const canReplace = hasResults && !this.searchController && !this.replaceController;
		this.replaceActions.setActions([
			{
				id: "search.preserveCase",
				label: localize("search.preserveCase", "Preserve Case"),
				tooltip: localize("search.preserveCase", "Preserve Case"),
				enabled: true,
				checked: this.preserveCase,
				run: () => { this.preserveCase = !this.preserveCase; this.updateResultActions(); },
			},
			{
				id: "search.replaceAll",
				label: localize("search.replaceAll", "Replace All"),
				tooltip: localize("search.replaceAll", "Replace All"),
				icon: Lxicon.edit,
				enabled: canReplace,
				run: () => this.replaceResults("all", false),
			},
		]);
		this.resultActions.setActions([
			{
				id: "search.refresh",
				label: localize("search.refresh", "Refresh search"),
				tooltip: localize("search.refresh", "Refresh search"),
				icon: Lxicon.refresh,
				enabled: this.queryInput.value.length > 0 && !this.searchController,
				run: () => this.startSearch(),
			},
			{
				id: "search.stop",
				label: localize("search.stop", "Stop search"),
				tooltip: localize("search.stop", "Stop search"),
				icon: Lxicon.close,
				enabled: Boolean(this.searchController),
				run: () => this.cancelSearch(),
			},
			{
				id: "search.clear",
				label: localize("search.clear", "Clear search results"),
				tooltip: localize("search.clear", "Clear search results"),
				icon: Lxicon.trash,
				enabled: hasResults || Boolean(this.searchController),
				run: () => this.clearResults(),
			},
			{
				id: "search.collapse",
				label: localize("search.collapse", "Collapse all results"),
				tooltip: localize("search.collapse", "Collapse all results"),
				icon: Lxicon.chevronUp,
				enabled: hasResults,
				run: () => {
					for (const node of this.tree.model.rootNodes) { this.tree.collapseRecursive(node.id); }
				},
			},
		], [
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
		]);
	}

	private async undoLatestReplacement(): Promise<void> {
		const undo = this.undoReplacement!;
		this.undoReplacement = undefined;
		this.replaceController = new AbortController();
		this.updateResultActions();
		try {
			await undo();
			if (!this.isDisposed) { await this.startSearch(); }
		} catch (error) {
			if (!this.isDisposed) { this.statusElement.textContent = error instanceof Error ? error.message : String(error); }
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
		const replacement = this.replaceInput.value;
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
			const result = await this.replaceService.replace(matches, query, replacement, { preview, preserveCase: this.preserveCase, signal: controller.signal });
			if (!result.isApplied || this.isDisposed) { return; }
			this.undoReplacement = result.undo;
			await this.startSearch();
			if (result.saveErrors.length) { this.statusElement.textContent = localize("search.replaceSaveFailed", "Changes were applied, but saving failed: {0}", result.saveErrors.join("; ")); }
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
		this.tree.setChildren(entries(roots));
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

	private renderResult(element: RenderableMatch): HTMLElement {
		const document = this.element.ownerDocument;
		const content = h(document, "span");
		content.className = "ash-search-result";
		if (element.kind === "match") {
			content.classList.add("ash-search-match");
			const line = h(document, "span");
			line.className = "ash-search-line-number";
			line.textContent = String(element.range.startLineNumber);
			const preview = h(document, "code");
			preview.className = "ash-search-preview";
			appendHighlightedPreview(document, preview, element.preview, [element.previewRange]);
			content.append(line, preview);
			content.setAttribute("aria-label", localize("search.matchLabel", "Line {0}, column {1}: {2}", element.range.startLineNumber, element.range.startColumn, element.preview));
		} else {
			content.classList.add("ash-search-file-heading");
			const label = h(document, "span");
			label.className = element.kind === "file" ? "ash-search-file-path" : "ash-search-folder-path";
			label.textContent = element.kind === "file" && !this.treeView ? `${element.folder.name} • ${element.path}` : element.name;
			content.append(label);
			if (element.kind === "file") {
				const count = h(document, "span");
				count.className = "ash-search-file-count";
				count.textContent = String(element.matches.length);
				content.append(count);
			}
		}
		this.rowHovers.set(content, this.hoverService.setupHover({ target: content, content: element.kind === "match" ? element.preview : element.resource.toString() }));
		return content;
	}
}

function input(
	document: Document,
	options: {
		readonly className: string;
		readonly placeholder: string;
		readonly ariaLabel: string;
	},
): HTMLInputElement {
	const element = h(document, "input");
	element.type = "text";
	element.className = options.className;
	element.placeholder = options.placeholder;
	element.setAttribute("aria-label", options.ariaLabel);
	element.autocomplete = "off";
	element.spellcheck = false;
	return element;
}

function patterns(value: string): readonly string[] {
	return value
		.split(",")
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0);
}

function appendHighlightedPreview(
	document: Document,
	container: HTMLElement,
	text: string,
	ranges: readonly ContentSearchMatchRange[],
): void {
	let offset = 0;
	for (const range of normalizedRanges(ranges, text.length)) {
		if (range.start > offset) {
			container.append(createText(document, text.slice(offset, range.start).replace(/\r\n|\r|\n/g, " ↵ ")));
		}
		const mark = h(document, "mark");
		mark.textContent = text.slice(range.start, range.end).replace(/\r\n|\r|\n/g, " ↵ ");
		container.append(mark);
		offset = range.end;
	}
	if (offset < text.length) {
		container.append(createText(document, text.slice(offset).replace(/\r\n|\r|\n/g, " ↵ ")));
	}
}

function normalizedRanges(
	ranges: readonly ContentSearchMatchRange[],
	length: number,
): readonly ContentSearchMatchRange[] {
	const normalized: ContentSearchMatchRange[] = [];
	for (const range of [...ranges].sort((left, right) =>
		left.start - right.start || left.end - right.end
	)) {
		const start = Math.max(0, Math.min(length, range.start));
		const end = Math.max(start, Math.min(length, range.end));
		const previous = normalized.at(-1);
		if (previous && start <= previous.end) {
			previous.end = Math.max(previous.end, end);
		} else if (start !== end) {
			normalized.push({ start, end });
		}
	}
	return normalized;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
