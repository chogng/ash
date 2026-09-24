import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { getOrSet } from "../../../../base/common/map.js";
import { type URI } from "../../../../base/common/uri.js";
import { Range } from "../../../../editor/common/core/range.js";
import { MarkerSeverity, type Marker } from "../../../../platform/markers/common/markers.js";
import { type IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { type IMarkerService } from "../../../../platform/markers/common/markers.js";

interface ProblemEntry {
	readonly marker: Marker;
}

const severities = Object.freeze([
	MarkerSeverity.Error,
	MarkerSeverity.Warning,
	MarkerSeverity.Information,
	MarkerSeverity.Hint,
]);

const severityLabels: Readonly<Record<MarkerSeverity, string>> = Object.freeze({
	[MarkerSeverity.Error]: "Errors",
	[MarkerSeverity.Warning]: "Warnings",
	[MarkerSeverity.Information]: "Information",
	[MarkerSeverity.Hint]: "Hints",
});

/** Aggregated workspace diagnostics with severity filtering and editor navigation. */
export class ProblemsViewPane extends ViewPane {
	private readonly filterInput: HTMLInputElement;
	private readonly titleActions: ActionBar;
	private readonly severityButtons = new Map<MarkerSeverity, HTMLButtonElement>();
	private readonly enabledSeverities = new Set<MarkerSeverity>(severities);
	private readonly statusElement: HTMLDivElement;
	private readonly resultsElement: HTMLUListElement;
	private renderedProblems: readonly ProblemEntry[] = [];
	private navigationError: string | undefined;

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly markerService: IMarkerService, private readonly editorService: IEditorService) {
		super(container, options);
		this.contentElement.classList.add("ash-problems");
		const document = container.ownerDocument;
		const controls = h(document, "div");
		controls.className = "ash-problems-controls";
		this.filterInput = h(document, "input");
		this.filterInput.type = "text";
		this.filterInput.className = "ash-problems-filter";
		this.filterInput.placeholder = "Filter problems";
		this.filterInput.setAttribute("aria-label", "Filter problems by message or file");
		this.filterInput.autocomplete = "off";
		this.filterInput.spellcheck = false;
		const focusFilterAction: IAction = {
			id: "ash.problems.focusFilter",
			label: "Filter Problems",
			tooltip: "Filter Problems",
			icon: lxiconsLibrary.filter,
			enabled: true,
			checked: undefined,
			run: () => this.filterInput.focus(),
		};
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, { ariaLabel: "Problems actions", actions: [focusFilterAction] }));
		this.titleActions.element.classList.add("ash-toolbar");
		const severityControls = h(document, "div");
		severityControls.className = "ash-problems-severities";
		severityControls.setAttribute("aria-label", "Problem severities");
		for (const severity of severities) {
			const button = h(document, "button");
			button.type = "button";
			button.className = `ash-problems-severity ${severity} checked`;
			button.textContent = severityLabels[severity];
			button.setAttribute("aria-pressed", "true");
			this.severityButtons.set(severity, button);
			severityControls.append(button);
			this._register(addDisposableListener(button, "click", () => this.toggleSeverity(severity)));
		}
		controls.append(this.filterInput, severityControls);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-problems-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.resultsElement = h(document, "ul");
		this.resultsElement.className = "ash-problems-results";
		this.resultsElement.setAttribute("aria-label", "Problems");
		this.contentElement.append(controls, this.statusElement, this.resultsElement);
		this._register(addDisposableListener(this.filterInput, "input", () => this.render()));
		this._register(addDisposableListener(this.resultsElement, "click", event => {
			const button = event.target instanceof container.ownerDocument.defaultView!.Element ? event.target.closest<HTMLButtonElement>(".ash-problems-item-button") : null;
			const index = Number(button?.dataset.problemIndex);
			const problem = Number.isSafeInteger(index) ? this.renderedProblems[index] : undefined;
			if (problem) void this.openProblem(problem);
		}));
		this._register(markerService.onDidChange(() => this.render()));
		this.render();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions.element };
	}

	private toggleSeverity(severity: MarkerSeverity): void {
		if (this.enabledSeverities.has(severity)) this.enabledSeverities.delete(severity);
		else this.enabledSeverities.add(severity);
		const button = this.severityButtons.get(severity)!;
		const enabled = this.enabledSeverities.has(severity);
		button.classList.toggle("checked", enabled);
		button.setAttribute("aria-pressed", String(enabled));
		this.render();
	}

	private render(): void {
		const all = markerEntries(this.markerService.getAll());
		const filter = this.filterInput.value.trim().toLocaleLowerCase();
		const visible = all.filter(entry => this.enabledSeverities.has(entry.marker.severity) && matchesFilter(entry, filter));
		this.renderedProblems = visible;
		const indexes = new Map(visible.map((problem, index) => [problem, index]));
		this.resultsElement.replaceChildren(...groupProblems(visible).map(group => this.renderGroup(group.resource, group.problems, indexes)));
		this.statusElement.textContent = this.navigationError ?? statusMessage(all.length, visible.length, filter, this.enabledSeverities.size);
	}

	private renderGroup(resource: URI, problems: readonly ProblemEntry[], indexes: ReadonlyMap<ProblemEntry, number>): HTMLLIElement {
		const document = this.element.ownerDocument;
		const group = h(document, "li");
		group.className = "ash-problems-file";
		const heading = h(document, "div");
		heading.className = "ash-problems-file-heading";
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
		return group;
	}

	private renderProblem(entry: ProblemEntry, index: number): HTMLLIElement {
		const document = this.element.ownerDocument;
		const item = h(document, "li");
		item.className = `ash-problems-item ${entry.marker.severity}`;
		const button = h(document, "button");
		button.type = "button";
		button.className = "ash-problems-item-button";
		button.dataset.problemIndex = String(index);
		button.title = `${entry.marker.message} — ${resourceName(entry.marker.resource)}:${entry.marker.range.start.lineIndex + 1}:${entry.marker.range.start.columnIndex + 1}`;
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
		location.textContent = `[Ln ${entry.marker.range.start.lineIndex + 1}, Col ${entry.marker.range.start.columnIndex + 1}]`;
		button.append(marker, message, source, location);
		item.append(button);
		return item;
	}

	private async openProblem(entry: ProblemEntry): Promise<void> {
		this.navigationError = undefined;
		try {
			await this.editorService.openEditor({ resource: entry.marker.resource, label: resourceName(entry.marker.resource) }, { selection: toEditorRange(entry.marker.range) });
		} catch (error) {
			if (this.isDisposed) return;
			this.navigationError = error instanceof Error ? error.message : "Could not open problem location.";
			this.render();
		}
	}
}

function markerEntries(markers: readonly Marker[]): readonly ProblemEntry[] {
	return markers.map(marker => ({ marker })).sort(compareProblems);
}

function compareProblems(left: ProblemEntry, right: ProblemEntry): number {
	return left.marker.resource.toString().localeCompare(right.marker.resource.toString()) || severities.indexOf(left.marker.severity) - severities.indexOf(right.marker.severity) || comparePositions(left.marker.range.start, right.marker.range.start) || left.marker.message.localeCompare(right.marker.message);
}

function groupProblems(problems: readonly ProblemEntry[]): readonly { readonly resource: URI; readonly problems: readonly ProblemEntry[] }[] {
	const groups = new Map<string, { readonly resource: URI; readonly problems: ProblemEntry[] }>();
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
	return `${marker.message} ${marker.source ?? ""} ${marker.code ?? ""} ${resourceName(marker.resource)} ${resourceParent(marker.resource)}`.toLocaleLowerCase().includes(filter);
}

function statusMessage(total: number, visible: number, filter: string, enabledSeverityCount: number): string {
	if (total === 0) return "No problems have been detected in the workspace.";
	if (visible === 0) return filter || enabledSeverityCount < severities.length ? `No problems match the current filters (${total} total).` : "No problems have been detected in the workspace.";
	return visible === total ? `${total} ${total === 1 ? "problem" : "problems"} in the workspace.` : `${visible} of ${total} problems shown.`;
}

function diagnosticSource(marker: Marker): string {
	if (marker.source && marker.code !== undefined) return `${marker.source}(${marker.code})`;
	if (marker.source) return marker.source;
	if (marker.code !== undefined) return String(marker.code);
	return "";
}

function comparePositions(left: Marker["range"]["start"], right: Marker["range"]["start"]): number {
	return left.lineIndex - right.lineIndex || left.columnIndex - right.columnIndex;
}

function toEditorRange(range: Marker["range"]): Range {
	return new Range(
		range.start.lineIndex + 1,
		range.start.columnIndex + 1,
		range.end.lineIndex + 1,
		range.end.columnIndex + 1,
	);
}

function resourceName(resource: URI): string {
	const path = decodedPath(resource);
	return path.slice(path.lastIndexOf("/") + 1) || resource.authority || resource.toString();
}

function resourceParent(resource: URI): string {
	const path = decodedPath(resource);
	const separator = path.lastIndexOf("/");
	return separator > 0 ? path.slice(0, separator) : resource.authority;
}

function decodedPath(resource: URI): string {
	try { return decodeURIComponent(resource.path); }
	catch { return resource.path; }
}
