import { addDisposableListener, h, isElement, stopEvent } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { ActionViewItem, ActionViewItemOptions } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { DropdownMenuActionViewItem } from "../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js";
import { Separator, SubmenuAction, type IAction } from "../../../../base/common/actions.js";
import type { Icon } from "../../../../base/common/icon.js";
import { MutableDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import type { IStorageService } from "../../../../platform/storage/common/storage.js";
import { StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import type { IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import type { IWorkbenchHostService } from "../../../services/host/common/workbenchHostService.js";
import type { IOutputChannel, IOutputEntry, IOutputService, OutputEntrySeverity } from "../../../services/output/common/outputService.js";
import { OutputFilterState, OutputSeverities } from "./outputFilterState.js";
import { detectOutputLinks } from "./outputLinks.js";
import { exportOutputChannel, openOutputChannelInEditor } from "./outputOperations.js";
import "./media/output.css";

const SelectChannelActionId = "ash.output.selectChannel";
const FilterActionId = "ash.output.filter";
const ClearChannelActionId = "ash.output.clear";
const AutoScrollActionId = "ash.output.autoScroll";
const MoreActionId = "ash.output.more";
const AutoScrollStorageKey = "output.autoScroll";
const MaximumRenderedEntries = 5_000;

/** Generic Output channel projection with filtering, navigation, and export. */
export class OutputViewPane extends ViewPane {
	private readonly activeChannelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly filters: OutputFilterState;
	private readonly filterInput: HTMLInputElement;
	private readonly content: HTMLDivElement;
	private readonly titleActions: ActionBar;
	private autoScroll: boolean;
	private titleStateKey = "";

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly outputService: IOutputService, private readonly contextMenuService: IContextMenuService, private readonly storageService?: IStorageService, private readonly editorService?: IEditorService, private readonly workspaceContextService?: IWorkspaceContextService, private readonly hostService?: IWorkbenchHostService) {
		super(container, options);
		this.contentElement.classList.add("ash-output");
		this.filters = this._register(new OutputFilterState(storageService));
		this.autoScroll = storageService?.getBoolean(AutoScrollStorageKey, StorageScope.WORKSPACE, true) ?? true;
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, { ariaLabel: "Output actions", highlightToggledItems: true, actionViewItemProvider: (action, actionOptions) => this.createActionViewItem(action, actionOptions) }));
		this.titleActions.element.classList.add("ash-toolbar", "ash-output-title-actions");
		const filterBar = h(container.ownerDocument, "div");
		filterBar.className = "ash-output-filter-bar";
		this.filterInput = h(container.ownerDocument, "input");
		this.filterInput.className = "ash-output-filter-input";
		this.filterInput.type = "search";
		this.filterInput.placeholder = "Filter Output (prefix with ! to exclude)";
		this.filterInput.setAttribute("aria-label", "Filter Output");
		this.filterInput.value = this.filters.text;
		filterBar.append(this.filterInput);
		this.content = h(container.ownerDocument, "div");
		this.content.className = "ash-output-content";
		this.content.setAttribute("role", "log");
		this.content.setAttribute("aria-live", "off");
		this.content.tabIndex = 0;
		this.contentElement.append(filterBar, this.content);
		this._register(addDisposableListener(this.filterInput, "input", () => this.filters.setText(this.filterInput.value)));
		this._register(addDisposableListener(this.filterInput, "keydown", event => {
			if (event.key !== "Escape" || !this.filterInput.value) return;
			stopEvent(event);
			this.filterInput.value = "";
			this.filters.setText("");
		}));
		this._register(addDisposableListener(this.contentElement, "keydown", event => {
			if (event.key.toLocaleLowerCase() !== "f" || (!event.ctrlKey && !event.metaKey)) return;
			stopEvent(event);
			this.filterInput.focus();
			this.filterInput.select();
		}));
		this._register(addDisposableListener(this.content, "scroll", () => this.acceptScrollPosition()));
		this._register(addDisposableListener(this.content, "click", event => this.openLink(event)));
		this._register(outputService.onDidChangeChannels(() => this.render()));
		this._register(outputService.onDidChangeActiveChannel(channel => this.bindActiveChannel(channel)));
		this._register(this.filters.onDidChange(() => this.render()));
		this.bindActiveChannel(outputService.activeChannel);
	}

	override get partTitleProjection(): PartTitleProjection { return { actions: this.titleActions.element }; }

	private bindActiveChannel(channel: IOutputChannel | undefined): void {
		this.activeChannelListener.value = channel?.onDidChange(() => this.render());
		this.render();
	}

	private render(): void {
		const active = this.outputService.activeChannel;
		const categories = active ? categoriesOf(active.entries) : [];
		const titleStateKey = [this.outputService.channels.map(channel => channel.id).join("\0"), active?.id ?? "", (active?.entries.length ?? 0) > 0, this.autoScroll, this.filters.text, ...OutputSeverities.map(severity => this.filters.isSeverityVisible(severity)), ...categories.map(category => `${category}:${this.filters.isCategoryVisible(category)}`)].join("\u0001");
		if (titleStateKey !== this.titleStateKey) {
			this.titleStateKey = titleStateKey;
			this.titleActions.updateActions(this.createTitleActions(active));
		}
		this.content.setAttribute("aria-label", active ? `Output: ${active.label}` : "Output");
		if (!active) { this.renderEmpty("No output channels are available."); return; }
		const filtered = active.entries.filter(entry => this.filters.matches(entry));
		if (active.entries.length === 0) { this.renderEmpty(`No output is available for ${active.label}.`); return; }
		if (filtered.length === 0) { this.renderEmpty(`No output from ${active.label} matches the current filter.`); return; }
		const rendered = filtered.slice(-MaximumRenderedEntries);
		const rows: HTMLElement[] = [];
		if (rendered.length < filtered.length) {
			const notice = h(this.element.ownerDocument, "div");
			notice.className = "ash-output-truncation";
			notice.textContent = `${(filtered.length - rendered.length).toLocaleString()} earlier matching entries are not rendered.`;
			rows.push(notice);
		}
		rows.push(...rendered.map(entry => this.renderEntry(entry)));
		this.content.replaceChildren(...rows);
		if (this.autoScroll) this.scrollToEnd();
	}

	private renderEntry(entry: IOutputEntry): HTMLElement {
		const row = h(this.element.ownerDocument, "div");
		row.className = `ash-output-row ${entry.severity}`;
		row.dataset.sequence = String(entry.sequence);
		if (entry.category) row.dataset.category = entry.category;
		row.title = `${severityLabel(entry.severity)}${entry.category ? ` · ${entry.category}` : ""}`;
		const links = detectOutputLinks(entry.text, this.workspaceContextService?.getWorkspace().folders ?? []);
		if (links.length === 0) { row.textContent = entry.text; return row; }
		let offset = 0;
		for (const link of links) {
			row.append(entry.text.slice(offset, link.startIndex));
			const anchor = h(row.ownerDocument, "a");
			anchor.className = "ash-output-link";
			anchor.href = link.resource.toString();
			anchor.textContent = link.label;
			anchor.title = `Open ${link.resource.toString()}`;
			anchor.dataset.resource = link.resource.toString();
			anchor.dataset.line = String(link.selection.getStartPosition().lineNumber);
			anchor.dataset.column = String(link.selection.getStartPosition().column);
			row.append(anchor);
			offset = link.endIndex;
		}
		row.append(entry.text.slice(offset));
		return row;
	}

	private renderEmpty(message: string): void {
		const empty = h(this.element.ownerDocument, "div");
		empty.className = "ash-output-empty";
		empty.textContent = message;
		this.content.replaceChildren(empty);
	}

	private openLink(event: MouseEvent): void {
		const target = isElement(event.target) ? event.target.closest<HTMLAnchorElement>(".ash-output-link") : null;
		const resourceValue = target?.dataset.resource;
		if (!target || !resourceValue || !this.editorService) return;
		stopEvent(event);
		const line = Number.parseInt(target.dataset.line ?? "0", 10);
		const column = Number.parseInt(target.dataset.column ?? "0", 10);
		const selection = Range.fromPositions(new Position((Number.isSafeInteger(line) ? line : 0) + 1, (Number.isSafeInteger(column) ? column : 0) + 1));
		void this.editorService.openEditor({ resource: URI.parse(resourceValue) }, { selection });
	}

	private createActionViewItem(action: IAction, options: ActionViewItemOptions): ActionViewItem | undefined {
		if (action.id === SelectChannelActionId) return new DropdownMenuActionViewItem(action, () => this.channelActions(), this.contextMenuService, options);
		if (action.id === FilterActionId) return new DropdownMenuActionViewItem(action, () => this.filterActions(), this.contextMenuService, options);
		if (action.id === MoreActionId) return new DropdownMenuActionViewItem(action, () => this.moreActions(), this.contextMenuService, options);
		return undefined;
	}

	private createTitleActions(active: IOutputChannel | undefined): readonly IAction[] {
		return [
			this.action(SelectChannelActionId, active?.label ?? "Select Output Channel", "Select Output Channel", undefined, this.outputService.channels.length > 0, undefined, () => undefined),
			this.action(FilterActionId, "Filter Output", "Filter Output", lxiconsLibrary.filter, Boolean(active), undefined, () => undefined),
			this.action(ClearChannelActionId, "Clear Output", active ? `Clear ${active.label}` : "Clear Output", lxiconsLibrary.eraser, (active?.entries.length ?? 0) > 0, undefined, () => active?.clear()),
			this.action(AutoScrollActionId, "Auto Scroll", this.autoScroll ? "Auto Scroll: On" : "Auto Scroll: Off", lxiconsLibrary.pinned, Boolean(active), this.autoScroll, () => this.toggleAutoScroll()),
			this.action(MoreActionId, "More Output Actions", "More Output Actions", lxiconsLibrary.ellipsis, Boolean(active), undefined, () => undefined),
		];
	}

	private channelActions(): readonly IAction[] {
		const activeId = this.outputService.activeChannel?.id;
		return this.outputService.channels.map(channel => this.action(`ash.output.channel.${channel.id}`, channel.label, channel.label, undefined, true, channel.id === activeId, () => this.outputService.selectChannel(channel.id)));
	}

	private filterActions(): readonly IAction[] {
		const categories = categoriesOf(this.outputService.activeChannel?.entries ?? []);
		const levelActions = (["trace", "debug", "information", "warning", "error"] as const).map(severity => this.action(`ash.output.filter.minimum.${severity}`, severityLabel(severity), `Show ${severityLabel(severity)} and above`, undefined, true, undefined, () => this.filters.setMinimumSeverity(severity)));
		const logLevel = new SubmenuAction("ash.output.filter.minimum", "Log Level", levelActions);
		const severityActions = OutputSeverities.map(severity => this.action(`ash.output.filter.severity.${severity}`, severityLabel(severity), `Show ${severityLabel(severity)}`, undefined, true, this.filters.isSeverityVisible(severity), () => this.filters.setSeverityVisible(severity, !this.filters.isSeverityVisible(severity))));
		const categoryActions = categories.map(category => this.action(`ash.output.filter.category.${category}`, category, `Show category ${category}`, undefined, true, this.filters.isCategoryVisible(category), () => this.filters.setCategoryVisible(category, !this.filters.isCategoryVisible(category))));
		return [logLevel, new Separator(), ...severityActions, ...(categoryActions.length ? [new Separator(), ...categoryActions] : []), new Separator(), this.action("ash.output.filter.reset", "Reset Filters", "Reset Output Filters", undefined, true, undefined, () => { this.filterInput.value = ""; this.filters.reset(); })];
	}

	private moreActions(): readonly IAction[] {
		const active = this.outputService.activeChannel;
		if (!active) return [];
		return [
			this.action("ash.output.openInEditor", "Open Output in Editor", `Open ${active.label} in Editor`, lxiconsLibrary.linkExternal, Boolean(this.editorService), undefined, () => this.editorService ? openOutputChannelInEditor(active, this.editorService) : undefined),
			this.action("ash.output.export", "Export Output…", `Export ${active.label}`, lxiconsLibrary.download, Boolean(this.hostService), undefined, () => this.hostService ? exportOutputChannel(active, this.hostService) : undefined),
		];
	}

	private toggleAutoScroll(): void {
		this.autoScroll = !this.autoScroll;
		this.persistAutoScroll();
		this.titleStateKey = "";
		if (this.autoScroll) this.scrollToEnd();
		this.render();
	}

	private acceptScrollPosition(): void {
		const atEnd = this.content.scrollHeight - this.content.scrollTop - this.content.clientHeight <= 2;
		if (this.autoScroll === atEnd) return;
		this.autoScroll = atEnd;
		this.persistAutoScroll();
		this.titleStateKey = "";
		this.titleActions.updateActions(this.createTitleActions(this.outputService.activeChannel));
	}

	private persistAutoScroll(): void {
		this.storageService?.store(AutoScrollStorageKey, this.autoScroll, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private scrollToEnd(): void { this.content.scrollTop = this.content.scrollHeight; }

	private action(id: string, label: string, tooltip: string, icon: Icon | undefined, enabled: boolean, checked: boolean | undefined, run: () => unknown): IAction {
		return { id, label, tooltip, icon, enabled, checked, run };
	}
}

function categoriesOf(entries: readonly IOutputEntry[]): readonly string[] {
	return [...new Set(entries.map(entry => entry.category).filter((value): value is string => Boolean(value)))].sort();
}

function severityLabel(severity: OutputEntrySeverity): string {
	return severity === "information" ? "Info" : `${severity[0]?.toLocaleUpperCase()}${severity.slice(1)}`;
}
