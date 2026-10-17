import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { appendIcon } from "../../../../base/browser/ui/lxicons/lxicon.js";
import { IClipboardService } from "../../../../platform/clipboard/common/clipboardService.js";
import { InputBox } from "../../../../base/browser/ui/inputbox/inputbox.js";
import { DropdownMenuActionViewItem } from "../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js";
import { localize } from "../../../../nls.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IWorkspaceContextService, WorkbenchState } from "../../../../platform/workspace/common/workspace.js";
import type { IAction } from "../../../../base/common/actions.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { getOrSet } from "../../../../base/common/map.js";
import { type URI } from "../../../../base/common/uri.js";
import { Range } from "../../../../editor/common/core/range.js";
import { MarkerSeverity, type IMarker } from "../../../../platform/markers/common/markers.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { IMarkerService } from "../../../../platform/markers/common/markers.js";

interface ProblemEntry {
	readonly marker: IMarker;
}

const severities = Object.freeze([
	MarkerSeverity.Error,
	MarkerSeverity.Warning,
	MarkerSeverity.Info,
	MarkerSeverity.Hint,
]);

// Severity is a bit mask in the domain contract; CSS keeps its existing semantic state names.
const severityClasses: Readonly<Record<MarkerSeverity, string>> = Object.freeze({
	[MarkerSeverity.Error]: 'error',
	[MarkerSeverity.Warning]: 'warning',
	[MarkerSeverity.Info]: 'information',
	[MarkerSeverity.Hint]: 'hint',
});

/** Aggregated workspace diagnostics with severity filtering and editor navigation. */
export class ProblemsViewPane extends ViewPane {
	private readonly filterInput: InputBox;
	private readonly titleControls: HTMLDivElement;
	private readonly titleActions: ActionBar;
	private readonly collapsedResources = new Set<string>();
	private actionsEnabled: boolean | undefined;
	private readonly clearFiltersButton: Button;
	private readonly enabledSeverities = new Set<MarkerSeverity>(severities);
	private readonly statusElement: HTMLDivElement;
	private readonly resultsElement: HTMLUListElement;
	private renderedProblems: readonly ProblemEntry[] = [];
	private interactionError: string | undefined;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IMarkerService private readonly markerService: IMarkerService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(container, options);
		this.contentElement.classList.add("ash-problems");
		const document = container.ownerDocument;
		const controls = this.titleControls = h(document, "div");
		controls.className = "ash-problems-controls";
		this._register(toDisposable(() => controls.remove()));
		this.filterInput = this._register(new InputBox(controls, {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: "compact",
			placeholder: localize('problems.filter', 'Filter problems'),
			ariaLabel: localize('problems.filterLabel', 'Filter problems by message or file'),
		}));
		this.filterInput.element.classList.add("ash-problems-filter");
		const filterActions = this._register(new ActionBar(this.filterInput.element, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			ariaLabel: localize('problems.actions', 'Problems actions'),
			actions: [{
				id: "ash.problems.filter",
				label: localize('problems.filterMenu', 'Filter'),
				tooltip: localize('problems.severities', 'Problem Severities'),
				icon: Lxicon.filter,
				enabled: true,
				checked: undefined,
				run: () => undefined,
			}],
			actionViewItemProvider: (action, options) => new DropdownMenuActionViewItem(
				action, () => this.severityActions(), contextMenuService, options),
		}));
		filterActions.element.classList.add("ash-toolbar");
		this.titleActions = this._register(new ActionBar(controls, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			ariaLabel: localize('problems.actions', 'Problems actions'),
		}));
		this.titleActions.element.classList.add("ash-toolbar");
		this.headerActionsElement.append(controls);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-problems-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.resultsElement = h(document, "ul");
		this.resultsElement.className = "ash-problems-results";
		this.resultsElement.setAttribute("aria-label", localize('problems.list', 'Problems'));
		const statusRow = h(document, "div");
		statusRow.className = "ash-problems-status-row";
		statusRow.append(this.statusElement);
		this.clearFiltersButton = this._register(new Button(statusRow, {
			...defaultButtonStyles,
			label: localize('problems.clearFilters', 'Clear Filters'),
			size: "small",
			onClick: () => this.clearFilters(),
		}));
		this.clearFiltersButton.domNode.hidden = true;
		this.contentElement.append(statusRow, this.resultsElement);
		this._register(this.filterInput.onDidChange(() => this.render()));
		this._register(workspaceService.onDidChangeWorkspace(() => this.render()));
		this._register(addDisposableListener(this.resultsElement, "click", event => {
			const target = event.target instanceof container.ownerDocument.defaultView!.Element ? event.target : undefined;
			const heading = target?.closest<HTMLButtonElement>(".ash-problems-file-heading");
			if (heading) {
				const resource = heading.dataset.resource!;
				if (this.collapsedResources.has(resource)) this.collapsedResources.delete(resource);
				else this.collapsedResources.add(resource);
				this.updateGroupExpansion(heading.closest<HTMLLIElement>(".ash-problems-file")!);
				return;
			}
			const button = target?.closest<HTMLButtonElement>(".ash-problems-item-button");
			const index = Number(button?.dataset.problemIndex);
			const problem = Number.isSafeInteger(index) ? this.renderedProblems[index] : undefined;
			if (problem) void this.openProblem(problem);
		}));
		this._register(markerService.onMarkerChanged(() => this.render()));
		this.render();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleControls };
	}

	private collapseAll(): void {
		for (const group of this.resultsElement.querySelectorAll<HTMLLIElement>(".ash-problems-file")) {
			const resource = group.querySelector<HTMLButtonElement>(".ash-problems-file-heading")!.dataset.resource!;
			this.collapsedResources.add(resource);
			this.updateGroupExpansion(group);
		}
	}

	private updateGroupExpansion(group: HTMLLIElement): void {
		const heading = group.querySelector<HTMLButtonElement>(".ash-problems-file-heading")!;
		const collapsed = this.collapsedResources.has(heading.dataset.resource!);
		heading.setAttribute("aria-expanded", String(!collapsed));
		group.classList.toggle("collapsed", collapsed);
		group.querySelector<HTMLUListElement>(".ash-problems-file-items")!.hidden = collapsed;
	}

	private async copyProblems(): Promise<void> {
		this.interactionError = undefined;
		const text = this.renderedProblems.map(({ marker }) => localize(
			'problems.copyEntry', '{0}({1},{2}): {3}: {4} {5}',
			marker.resource.scheme === 'file' ? marker.resource.fsPath : marker.resource.toString(),
			marker.startLineNumber, marker.startColumn, severityLabel(marker.severity), marker.message, diagnosticSource(marker),
		).trimEnd()).join("\n");
		try {
			await this.clipboardService.writeText(text);
			if (!this.isDisposed) this.render();
		} catch {
			if (this.isDisposed) return;
			this.interactionError = localize('problems.copyFailed', 'Could not copy problems.');
			this.render();
		}
	}

	private severityActions(): readonly IAction[] {
		return severities.map(severity => ({
			id: `ash.problems.severity.${severityClasses[severity]}`,
			label: severityLabel(severity),
			tooltip: severityLabel(severity),
			enabled: true,
			checked: this.enabledSeverities.has(severity),
			run: () => {
				if (this.enabledSeverities.has(severity)) this.enabledSeverities.delete(severity);
				else this.enabledSeverities.add(severity);
				this.render();
			},
		}));
	}

	private clearFilters(): void {
		this.filterInput.value = "";
		for (const severity of severities) this.enabledSeverities.add(severity);
		this.render();
		this.filterInput.focus();
	}

	private render(): void {
		const all = markerEntries(this.markerService.read());
		const filter = this.filterInput.value.trim().toLocaleLowerCase();
		const visible = all.filter(entry => this.enabledSeverities.has(entry.marker.severity) && matchesFilter(entry, filter));
		this.renderedProblems = visible;
		const resources = new Set(all.map(entry => entry.marker.resource.toString()));
		for (const resource of this.collapsedResources) {
			if (!resources.has(resource)) this.collapsedResources.delete(resource);
		}
		const enabled = visible.length > 0;
		if (enabled !== this.actionsEnabled) {
			this.actionsEnabled = enabled;
			this.titleActions.updateActions([{
				id: "ash.problems.collapseAll",
				label: localize('problems.collapseAll', 'Collapse All'),
				tooltip: localize('problems.collapseAll', 'Collapse All'),
				icon: Lxicon.collapseAll, enabled, checked: undefined,
				run: () => this.collapseAll(),
			}, {
				id: "ash.problems.copy",
				label: localize('problems.copy', 'Copy Problems'),
				tooltip: localize('problems.copy', 'Copy Problems'),
				icon: Lxicon.copy, enabled, checked: undefined,
				run: () => this.copyProblems(),
			}]);
		}
		const indexes = new Map(visible.map((problem, index) => [problem, index]));
		this.resultsElement.replaceChildren(...groupProblems(visible).map(group => this.renderGroup(group.resource, group.problems, indexes)));
		const hasFilters = Boolean(filter) || this.enabledSeverities.size < severities.length;
		this.clearFiltersButton.domNode.hidden = !hasFilters;
		this.statusElement.textContent = this.interactionError ?? statusMessage(all.length, visible.length, hasFilters, this.workspaceService.getWorkbenchState());
	}

	private renderGroup(resource: URI, problems: readonly ProblemEntry[], indexes: ReadonlyMap<ProblemEntry, number>): HTMLLIElement {
		const document = this.element.ownerDocument;
		const group = h(document, "li");
		group.className = "ash-problems-file";
		const heading = h(document, "button");
		heading.type = "button";
		heading.className = "ash-problems-file-heading";
		heading.dataset.resource = resource.toString();
		const twisty = appendIcon(Lxicon.chevronDown, heading);
		twisty.classList.add("ash-problems-file-twisty");
		twisty.setAttribute("aria-hidden", "true");
		const name = h(document, "span");
		name.className = "ash-problems-file-name";
		name.textContent = resourceName(resource);
		const path = h(document, "span");
		path.className = "ash-problems-file-path";
		path.textContent = resourceParent(resource);
		const count = h(document, "span");
		count.className = "ash-problems-file-count";
		count.textContent = String(problems.length);
		heading.append(name, path, count);
		const rows = h(document, "ul");
		rows.className = "ash-problems-file-items";
		rows.append(...problems.map(problem => this.renderProblem(problem, indexes.get(problem)!)));
		group.append(heading, rows);
		this.updateGroupExpansion(group);
		return group;
	}

	private renderProblem(entry: ProblemEntry, index: number): HTMLLIElement {
		const document = this.element.ownerDocument;
		const item = h(document, "li");
		item.className = `ash-problems-item ${severityClasses[entry.marker.severity]}`;
		const button = h(document, "button");
		button.type = "button";
		button.className = "ash-problems-item-button";
		button.dataset.problemIndex = String(index);
		button.title = `${entry.marker.message} — ${resourceName(entry.marker.resource)}:${entry.marker.startLineNumber}:${entry.marker.startColumn}`;
		const marker = h(document, "span");
		marker.className = "ash-problems-marker";
		marker.setAttribute("aria-hidden", "true");
		const message = h(document, "span");
		message.className = "ash-problems-message";
		message.textContent = entry.marker.message;
		const source = h(document, "span");
		source.className = "ash-problems-source";
		source.textContent = diagnosticSource(entry.marker);
		const location = h(document, "span");
		location.className = "ash-problems-location";
		location.textContent = localize('problems.location', '[Ln {0}, Col {1}]', entry.marker.startLineNumber, entry.marker.startColumn);
		button.append(marker, message, source, location);
		item.append(button);
		return item;
	}

	private async openProblem(entry: ProblemEntry): Promise<void> {
		this.interactionError = undefined;
		try {
			await this.editorService.openEditor({ resource: entry.marker.resource, label: resourceName(entry.marker.resource) }, { selection: new Range(entry.marker.startLineNumber, entry.marker.startColumn, entry.marker.endLineNumber, entry.marker.endColumn) });
		} catch (error) {
			if (this.isDisposed) return;
			this.interactionError = error instanceof Error ? error.message : localize('problems.openFailed', 'Could not open problem location.');
			this.render();
		}
	}
}

function markerEntries(markers: readonly IMarker[]): readonly ProblemEntry[] {
	return markers.map(marker => ({ marker })).sort(compareProblems);
}

function compareProblems(left: ProblemEntry, right: ProblemEntry): number {
	return left.marker.resource.toString().localeCompare(right.marker.resource.toString()) || severities.indexOf(left.marker.severity) - severities.indexOf(right.marker.severity) || left.marker.startLineNumber - right.marker.startLineNumber || left.marker.startColumn - right.marker.startColumn || left.marker.message.localeCompare(right.marker.message);
}

function groupProblems(problems: readonly ProblemEntry[]): readonly { readonly resource: URI; readonly problems: readonly ProblemEntry[]; }[] {
	const groups = new Map<string, { readonly resource: URI; readonly problems: ProblemEntry[]; }>();
	for (const problem of problems) {
		const key = problem.marker.resource.toString();
		const group = getOrSet(groups, key, { resource: problem.marker.resource, problems: [] });
		group.problems.push(problem);
	}
	return [...groups.values()];
}

function matchesFilter(entry: ProblemEntry, filter: string): boolean {
	if (!filter) return true;
	const marker = entry.marker;
	const code = typeof marker.code === 'object' ? marker.code.value : marker.code;
	return `${marker.message} ${marker.source ?? ""} ${code ?? ""} ${resourceName(marker.resource)} ${resourceParent(marker.resource)}`.toLocaleLowerCase().includes(filter);
}

function severityLabel(severity: MarkerSeverity): string {
	switch (severity) {
		case MarkerSeverity.Error: return localize('problems.errors', 'Errors');
		case MarkerSeverity.Warning: return localize('problems.warnings', 'Warnings');
		case MarkerSeverity.Info: return localize('problems.information', 'Information');
		case MarkerSeverity.Hint: return localize('problems.hints', 'Hints');
	}
}

function statusMessage(total: number, visible: number, hasFilters: boolean, state: WorkbenchState): string {
	// Loose files can still publish diagnostics in an empty window, so actual markers take precedence.
	if (total === 0) return state === WorkbenchState.EMPTY
		? localize('problems.noProject', 'Open a folder to view project diagnostics.')
		: localize('problems.empty', 'No problems detected.');
	if (visible === 0 && hasFilters) return localize('problems.noMatches', 'No problems match the current filters ({0} total).', total);
	if (visible !== total) return localize('problems.filteredCount', '{0} of {1} problems shown.', visible, total);
	return total === 1 ? localize('problems.oneProblem', '1 problem in the workspace.') : localize('problems.count', '{0} problems in the workspace.', total);
}

function diagnosticSource(marker: IMarker): string {
	const code = typeof marker.code === 'object' ? marker.code.value : marker.code;
	if (marker.source && code !== undefined) return `${marker.source}(${code})`;
	if (marker.source) return marker.source;
	if (code !== undefined) return code;
	return "";
}

function resourceName(resource: URI): string {
	const path = resource.path;
	return path.slice(path.lastIndexOf("/") + 1) || resource.authority || resource.toString();
}

function resourceParent(resource: URI): string {
	const path = resource.path;
	const separator = path.lastIndexOf("/");
	return separator > 0 ? path.slice(0, separator) : resource.authority;
}
