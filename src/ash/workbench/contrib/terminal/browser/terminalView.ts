import {
	TerminalCreatingContext,
	TerminalHasActiveInstanceContext,
	TerminalActiveInstanceInTitleContext,
	TerminalActiveInstanceStateContext,
} from '../common/terminalContextKey.js';
import { TerminalCommandId } from '../common/terminal.js';
import { terminalProfileIcon } from "./terminalIcon.js";
import { type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { DropdownWithPrimaryActionViewItem } from "../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js";
import type { IAction } from "../../../../base/common/actions.js";
import { ActionViewItem, LabelActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalVoiceSession } from '../../terminalContrib/voice/browser/terminalVoice.js';
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { AppServerRemoteError } from "../../../../platform/agentHost/common/appServerError.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import { type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, ITerminalService } from "./terminal.js";
import type { XtermTerminal } from "./xterm/xtermTerminal.js";
import { TerminalTabbedView } from "./terminalTabbedView.js";
import "./media/terminal.css";
import { h } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";

const DEFAULT_DIMENSIONS: ITerminalDimensions = { rows: 24, cols: 80 };

/** Tabbed xterm panel whose persistent widgets preserve per-instance terminal state. */
export class TerminalViewPane extends ViewPane {
	private readonly terminalService: ITerminalService;
	private readonly titleActions: TerminalTitleActions;
	private readonly statusElement: HTMLDivElement;
	private readonly tabsLayout: TerminalTabbedView;
	private readonly widgetsElement: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<ITerminalInstance, TerminalViewItem>());
	private readonly voice: TerminalVoiceSession;
	private creating = false;
	private initializing = false;
	private focusSource: Element | null | undefined;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ITerminalService terminalService: ITerminalService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(container, options);
		this.terminalService = terminalService;
		this.element.classList.add("ash-terminal-view");
		this.headerElement.remove();
		this.titleActions = this._register(instantiation.createInstance(TerminalTitleActions, this.headerActionsElement));

		this.contentElement.classList.add("ash-terminal-content");
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-terminal-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.hidden = true;
		this.contentElement.append(this.statusElement);
		this.tabsLayout = this._register(instantiation.createInstance(TerminalTabbedView, this.contentElement));
		this.widgetsElement = this.tabsLayout.terminalContainer;
		this._register(this.tabsLayout.onDidFocusInstance(() => this.focus()));
		this.voice = this._register(instantiation.createInstance(TerminalVoiceSession, this.contentElement, () => this.isBodyVisible() && !this.isDisposed, () => this.activeItem()?.widget.focus()));

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
				this.voice.hide();
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

	public startVoice(): Promise<void> { return this.voice.start(); }
	public stopVoice(): Promise<void> { return this.voice.stop(); }
	public async getTerminalOutput(instance: ITerminalInstance, maxCharacters: number, signal: AbortSignal): Promise<string | undefined> {
		const item = this.items.get(instance);
		if (!item || this.isDisposed || signal.aborted) { return undefined; }
		const content = await item.widget.getBufferText(maxCharacters, signal);
		return this.items.get(instance) === item && !signal.aborted ? content : undefined;
	}

	public async openDetectedLink(): Promise<void> { await this.activeItem()?.widget.openDetectedLink(); }

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
			if (this.terminalService.instances.length === 0) {
				this.setStatus("Open a folder to use the terminal.");
			}
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
		if (this.isBodyVisible() && !this.isDisposed && this.terminalService.instances.length === 0) await this.createTerminal(undefined, false);
	}

	public async createTerminal(profileId?: string, focus = true): Promise<void> {
		if (this.creating || this.isDisposed) return;
		if (!this.hasWorkspaceFolder()) {
			this.setStatus("Open a folder to use the terminal.");
			return;
		}
		if (focus) {
			if (this.isBodyVisible()) super.focus();
			this.focusSource = this.element.ownerDocument.activeElement;
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

	public async relaunchActive(): Promise<void> {
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

	public async killActive(): Promise<void> {
		const instance = this.terminalService.activeInstance;
		if (!instance) return;
		await this.terminalService.closeTerminal(instance);
		if (!this.isDisposed) this.layoutService.hidePart("panel");
	}

	public clearActive(): void {
		this.activeItem()?.widget.clearBuffer();
		this.focus();
	}

	private addInstance(instance: ITerminalInstance): void {
		if (this.items.has(instance)) return;
		instance.attachToElement(this.widgetsElement);
		const item = new TerminalViewItem(
			instance,
			instance.xterm!,
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
		void item.instance.xtermReadyPromise.catch(error => {
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
		for (const [instance, item] of this.items) {
			item.widget.setVisible(this.isBodyVisible() && !this.isDisposed && instance === active);
		}
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
		readonly widget: XtermTerminal,
		onDidChangeState: () => void,
	) {
		super();
		this._register(toDisposable(() => instance.detachFromElement()));
		this._register(instance.onDidChangeState(onDidChangeState));
	}
}

/** Owns the terminal title toolbar and its window-scoped enablement state. */
export class TerminalTitleActions extends Disposable {
	readonly element: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;
	private readonly creatingContext: IContextKey<boolean>;
	private readonly hasActiveInstanceContext: IContextKey<boolean>;
	private readonly activeInstanceInTitleContext: IContextKey<boolean>;
	private readonly activeInstanceStateContext: IContextKey<string>;
	private readonly commandService: ICommandService;
	private profiles: readonly ITerminalProfile[] = [];
	private activeInstance: ITerminalInstance | undefined;

	constructor(
		container: HTMLElement,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this.commandService = commandService;
		this.creatingContext = TerminalCreatingContext.bindTo(contextKeyService);
		this.hasActiveInstanceContext = TerminalHasActiveInstanceContext.bindTo(contextKeyService);
		this.activeInstanceInTitleContext = TerminalActiveInstanceInTitleContext.bindTo(contextKeyService);
		this.activeInstanceStateContext = TerminalActiveInstanceStateContext.bindTo(contextKeyService);
		this._register(toDisposable(() => {
			this.activeInstanceStateContext.reset();
			this.activeInstanceInTitleContext.reset();
			this.hasActiveInstanceContext.reset();
			this.creatingContext.reset();
		}));
		this.toolbar = this._register(new MenuWorkbenchToolBar(
			container,
			menuService,
			contextMenuService,
			MenuId.TerminalTitle,
			{
				ariaLabel: localize('terminal.title.actions', "Terminal actions"),
				highlightToggledItems: true,
				menuOptions: { shouldForwardArgs: true },
				actionViewItemProvider: (action) => this.createActionViewItem(action, contextMenuService),
			},
		));
		this.element = this.toolbar.element;
		this.element.classList.add("ash-terminal-title-toolbar");
	}

	setProfiles(profiles: readonly ITerminalProfile[]): void {
		this.profiles = profiles;
		this.toolbar.refresh();
	}

	setCreating(creating: boolean): void {
		this.creatingContext.set(creating);
	}

	setActiveInstance(instance: ITerminalInstance | undefined, placement: "list" | "title"): void {
		this.activeInstance = instance;
		this.activeInstanceInTitleContext.set(instance !== undefined && placement === "title");
		this.hasActiveInstanceContext.set(instance !== undefined);
		this.activeInstanceStateContext.set(instance?.state ?? "none");
		this.toolbar.refresh();
	}


	private createActionViewItem(action: IAction, contextMenuService: IContextMenuService): ActionViewItem | undefined {
		switch (action.id) {
			case TerminalCommandId.Focus:
				if (!this.activeInstance) return undefined;
				return new ActiveTerminalActionViewItem(action, this.activeInstance);
			case TerminalCommandId.New:
				return new DropdownWithPrimaryActionViewItem(
					action,
					new TerminalProfileSelectorAction(action.enabled && this.profiles.length > 0, (profileId) => this.createTerminalWithProfile(profileId)),
					() => this.profiles.map((profile) => terminalProfileMenuAction(profile, () => this.activeInstance?.profile.profileId, (profileId) => this.createTerminalWithProfile(profileId))),
					contextMenuService,
				);
			default:
				return undefined;
		}
	}

	private createTerminalWithProfile(profileId: unknown): unknown {
		if (typeof profileId !== "string" || !this.profiles.some((profile) => profile.profileId === profileId)) {
			throw new TypeError(`Unknown terminal profile: ${String(profileId)}`);
		}
		return this.commandService.executeCommand(TerminalCommandId.NewWithProfile, profileId);
	}
}

class ActiveTerminalActionViewItem extends LabelActionViewItem {
	constructor(action: IAction, private readonly instance: ITerminalInstance) {
		const tooltip = instance.title === instance.profile.title
			? localize('terminal.title.active', 'Active terminal: {0}', instance.title)
			: localize('terminal.title.activeProfile', 'Active terminal: {0} ({1})', instance.title, instance.profile.title);
		super(action, {
			label: instance.title,
			icon: terminalProfileIcon(instance.profile),
			ariaLabel: tooltip,
			tooltip,
		});
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-terminal-active-action");
		container.dataset.state = this.instance.state;
	}
}

class TerminalProfileSelectorAction implements IAction {
	readonly id = TerminalCommandId.NewWithProfile;
	readonly label = localize('terminal.title.selectProfile', "Select Terminal Profile");
	readonly tooltip = localize('terminal.title.selectProfile', "Select Terminal Profile");
	readonly checked = undefined;

	constructor(readonly enabled: boolean, private readonly createTerminalWithProfile: (profileId: unknown) => unknown) { }

	run(...args: readonly unknown[]): unknown {
		return this.createTerminalWithProfile(args[0]);
	}
}

function terminalProfileMenuAction(profile: ITerminalProfile, activeProfileId: () => string | undefined, createTerminalWithProfile: (profileId: unknown) => unknown): IAction {
	const label = profile.isDefault ? localize('terminal.title.defaultProfile', '{0} (Default)', profile.title) : profile.title;
	return {
		id: `${TerminalCommandId.NewWithProfile}.${profile.profileId}`,
		label,
		tooltip: localize('terminal.title.useProfile', 'Use {0}', profile.title),
		icon: terminalProfileIcon(profile),
		enabled: true,
		checked: profile.profileId === activeProfileId(),
		run: () => createTerminalWithProfile(profile.profileId),
	};
}
