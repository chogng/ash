import { TabList, type TabListDropPosition } from "../../../../base/browser/ui/tablist/tabList.js";
import { Disposable, DisposableMap } from "../../../../base/common/lifecycle.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import type { IMenuService } from "../../../../platform/actions/common/menuService.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import type { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import type { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import type { ITerminalDimensions, ITerminalInstance, ITerminalService } from "../../../services/terminal/common/terminal.js";
import { TerminalInstanceWidget } from "./instance/terminalInstanceWidget.js";
import { TerminalTabsLayout } from "./view/terminalTabsLayout.js";
import { terminalProfileIcon } from "./view/terminalProfileIcon.js";
import { TerminalTitleActions } from "./view/terminalTitleActions.js";
import "./view/media/terminal.css";
import { h } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";

const DEFAULT_DIMENSIONS: ITerminalDimensions = { rows: 24, cols: 80 };

/** Tabbed xterm panel whose persistent widgets preserve per-instance terminal state. */
export class TerminalViewPane extends ViewPane {
	private readonly terminalService: ITerminalService;
	private readonly themeService: IThemeService;
	private readonly titleActions: TerminalTitleActions;
	private readonly statusElement: HTMLDivElement;
	private readonly tabList: TabList<ITerminalInstance>;
	private readonly tabsLayout: TerminalTabsLayout;
	private readonly widgetsElement: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<ITerminalInstance, TerminalViewItem>());
	private draggedTerminal: ITerminalInstance | undefined;
	private creating = false;
	private initializing = false;
	private focusSource: Element | null | undefined;

	constructor(container: HTMLElement, options: IViewPaneOptions, terminalService: ITerminalService, themeService: IThemeService, menuService: IMenuService, contextMenuService: IContextMenuService, contextKeyService: IContextKeyService, private readonly layoutService: IWorkbenchLayoutService, private readonly workspaceContext: IWorkspaceContextService) {
		super(container, options);
		this.terminalService = terminalService;
		this.themeService = themeService;
		this.element.classList.add("ash-terminal-view");
		this.headerElement.remove();
		this.titleActions = this._register(new TerminalTitleActions(this.headerActionsElement, {
			menuService,
			contextMenuService,
			contextKeyService,
			createTerminal: (profileId) => {
				if (this.isBodyVisible()) super.focus();
				this.focusSource = this.element.ownerDocument.activeElement;
				return this.createTerminal(profileId);
			},
			focusActive: () => this.focus(),
			relaunchActive: () => this.relaunchActive(),
			killActive: () => this.killActive(),
			clearActive: () => this.clearActive(),
		}));

		this.contentElement.classList.add("ash-terminal-content");
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-terminal-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.hidden = true;
		this.tabList = this._register(new TabList(this.contentElement, {
			ariaLabel: "Terminal instances",
			orientation: "vertical",
			draggable: true,
			dragAndDrop: {
				canDrop: () => this.draggedTerminal !== undefined,
				onDragStart: (instance) => {
					this.draggedTerminal = instance;
				},
				onDrop: (target, position) => {
					const source = this.draggedTerminal;
					if (source) this.moveTerminalTab(source, target, position);
				},
				onDragEnd: () => {
					this.draggedTerminal = undefined;
				},
			},
			closeActionIcon: lxiconsLibrary.trash,
			onActivate: (instance) => {
				this.terminalService.setActiveInstance(instance);
				this.focus();
			},
			onClose: (instance) => {
				void this.terminalService.closeTerminal(instance).catch(() => {});
			},
		}));
		this.tabList.element.classList.add("ash-terminal-tabs");
		this.widgetsElement = h(container.ownerDocument, "div");
		this.widgetsElement.className = "ash-terminal-widgets";
		this.tabsLayout = this._register(new TerminalTabsLayout(this.widgetsElement, this.tabList.element));
		this.contentElement.append(this.statusElement, this.tabsLayout.element);

		for (const instance of terminalService.instances) this.addInstance(instance);
		this._register(terminalService.onDidCreateInstance((instance) => {
			this.addInstance(instance);
			this.updateInstances();
		}));
		this._register(terminalService.onDidDisposeInstance((instance) => {
			this.removeInstance(instance);
			this.updateInstances();
		}));
		this._register(terminalService.onDidChangeActiveInstance(() => this.updateInstances()));
		this._register(terminalService.onDidChangeInstances(() => this.updateInstances()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				queueMicrotask(() => {
					this.updateInstances();
					void this.initialize();
				});
			} else {
				this.focusSource = undefined;
				this.updateInstances();
			}
		}));
		this._register(workspaceContext.onDidChangeWorkspace(({ workspace }) => {
			if (workspace.folders.length > 0 && this.terminalService.instances.length === 0) void this.initialize();
		}));

		this._register(observeResize([this.tabsLayout.element, this.widgetsElement], () => {
			const bounds = this.tabsLayout.element.getBoundingClientRect();
			this.tabsLayout.layout(bounds.width, bounds.height);
			this.activeItem()?.widget.fit();
		}));
		this.render();
		queueMicrotask(() => {
			this.updateInstances();
			void this.initialize();
		});
	}

	override focus(): void {
		if (!this.isVisible() || this.isDisposed) return;
		this.setExpanded(true);
		super.focus();
		this.focusSource = this.element.ownerDocument.activeElement;
		this.updateInstances();
		void this.initialize();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions.element };
	}

	private async initialize(): Promise<void> {
		if (!this.isBodyVisible() || this.isDisposed || this.initializing) return;
		if (!this.hasWorkspaceFolder()) {
			this.titleActions.setProfiles([]);
			this.setStatus("Open a folder to use the terminal.");
			return;
		}
		this.initializing = true;
		try {
			const profiles = await this.terminalService.getProfiles();
			if (this.isDisposed) return;
			this.titleActions.setProfiles(profiles);
		} catch {
			if (this.isDisposed) return;
			this.titleActions.setProfiles([]);
		} finally {
			this.initializing = false;
		}
		if (this.isBodyVisible() && !this.isDisposed && this.terminalService.instances.length === 0) await this.createTerminal();
	}

	private async createTerminal(profileId?: string): Promise<void> {
		if (this.creating || this.isDisposed) return;
		if (!this.hasWorkspaceFolder()) {
			this.setStatus("Open a folder to use the terminal.");
			return;
		}
		this.creating = true;
		this.titleActions.setCreating(true);
		this.setStatus(undefined);
		try {
			await this.terminalService.createTerminal({
				dimensions: this.activeItem()?.widget.dimensions() ?? DEFAULT_DIMENSIONS,
				profile: profileId ? { type: "profile", profileId } : { type: "default" },
			});
		} catch (error) {
			if (!this.isDisposed) {
				this.focusSource = undefined;
				this.setStatus(terminalErrorMessage(error, "Terminal is unavailable"));
			}
		} finally {
			this.creating = false;
			if (!this.isDisposed) {
				this.titleActions.setCreating(false);
				this.updateInstances();
			}
		}
	}

	private async relaunchActive(): Promise<void> {
		const instance = this.terminalService.activeInstance;
		const item = instance ? this.items.get(instance) : undefined;
		if (!instance || !item || instance.state === "running" || instance.state === "reconnecting") return;
		if (this.isBodyVisible()) super.focus();
		const focusSource = this.element.ownerDocument.activeElement;
		this.setStatus(undefined);
		try {
			await this.terminalService.relaunchTerminal(instance, item.widget.dimensions());
			if (!this.isDisposed && this.activeItem() === item && this.element.ownerDocument.activeElement === focusSource) item.widget.focus();
		} catch (error) {
			if (!this.isDisposed) {
				this.setStatus(terminalErrorMessage(error, "Terminal relaunch failed"));
			}
		}
	}

	private async killActive(): Promise<void> {
		const instance = this.terminalService.activeInstance;
		if (!instance) return;
		await this.terminalService.closeTerminal(instance);
		if (!this.isDisposed) this.layoutService.hidePart("panel");
	}

	private clearActive(): void {
		this.activeItem()?.widget.clear();
		this.focus();
	}

	private addInstance(instance: ITerminalInstance): void {
		if (this.items.has(instance)) return;
		const item = new TerminalViewItem(
			instance,
			new TerminalInstanceWidget(this.widgetsElement, instance, this.themeService),
			() => this.updateInstances(),
		);
		this.items.set(instance, item);
	}

	private updateInstances(): void {
		this.render();
		if (!this.isBodyVisible() || this.isDisposed) return;
		const item = this.activeItem();
		if (!item) return;
		if (!this.creating && this.focusSource !== undefined) {
			if (this.element.ownerDocument.activeElement === this.focusSource) item.widget.focus();
			this.focusSource = undefined;
		}
		void item.widget.initialize().catch(error => {
			if (this.isDisposed || this.items.get(item.instance) !== item) return;
			this.removeInstance(item.instance);
			this.setStatus(terminalErrorMessage(error, "Terminal renderer could not be loaded"));
		});
	}

	private removeInstance(instance: ITerminalInstance): void {
		this.items.deleteAndDispose(instance);
	}

	private render(): void {
		if (this.isDisposed) return;
		const active = this.terminalService.activeInstance;
		const instanceSwitcherPlacement = this.terminalService.instances.length > 1 ? "list" : "title";
		this.titleActions.setActiveInstance(active, instanceSwitcherPlacement);
		this.tabsLayout.setInstanceListPresentation(instanceSwitcherPlacement === "list" ? "visible" : "hidden");
		for (const [instance, item] of this.items) {
			item.widget.setVisible(this.isBodyVisible() && !this.isDisposed && instance === active);
		}
		this.renderTabs();
	}

	private renderTabs(): void {
		const active = this.terminalService.activeInstance;
		this.tabList.setTabs(this.terminalService.instances.map((instance) => ({
			id: instance.id,
			value: instance,
			label: instance.title,
			tooltip: instance.title,
			icon: terminalProfileIcon(instance.profile),
			state: instance.state,
			tabId: `${instance.id}-tab`,
		})), active?.id);
	}

	private moveTerminalTab(source: ITerminalInstance, target: ITerminalInstance | undefined, position: TabListDropPosition): void {
		if (source === target) return;
		const instances = this.terminalService.instances;
		const sourceIndex = instances.indexOf(source);
		if (sourceIndex < 0) return;
		const targetIndex = target === undefined
			? instances.length
			: instances.indexOf(target);
		const insertionIndex = targetIndex < 0
			? instances.length - 1
			: position === "before" ? targetIndex : targetIndex + 1;
		this.terminalService.moveTerminal(source, insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex);
	}

	private activeItem(): TerminalViewItem | undefined {
		const active = this.terminalService.activeInstance;
		return active ? this.items.get(active) : undefined;
	}

	private setStatus(message: string | undefined): void {
		this.statusElement.textContent = message ?? "";
		this.statusElement.hidden = message === undefined;
	}

	private hasWorkspaceFolder(): boolean {
		return this.workspaceContext.getWorkspace().folders.length > 0;
	}

}

function terminalErrorMessage(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error);
	const errorName = error instanceof AppServerRemoteError ? error.errorName : message;
	if (/TerminalUnavailable/.test(errorName)) {
		return "Terminal is unavailable for this folder. Trust the folder to enable terminal processes, or continue in Restricted Mode.";
	}
	return error instanceof Error ? error.message : fallback;
}

class TerminalViewItem extends Disposable {
	constructor(
		readonly instance: ITerminalInstance,
		readonly widget: TerminalInstanceWidget,
		onDidChangeState: () => void,
	) {
		super();
		this._register(widget);
		this._register(instance.onDidChangeState(onDidChangeState));
	}
}
