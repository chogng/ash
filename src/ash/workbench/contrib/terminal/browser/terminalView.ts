import {
	TerminalCreatingContext,
	TerminalHasActiveInstanceContext,
	TerminalActiveInstanceInTitleContext,
	TerminalActiveInstanceStateContext,
	TerminalViewInlineActionsContext,
	TerminalContextKeys,
} from '../common/terminalContextKey.js';
import { TerminalCommandId } from '../common/terminal.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../../../services/terminal/common/terminal.js';
import { ITerminalProcessService, TerminalLocation, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { terminalProfileIcon } from "./terminalIcon.js";
import { type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { DropdownWithPrimaryActionViewItem } from "../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js";
import { Separator, SubmenuAction, type IAction } from "../../../../base/common/actions.js";
import { MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { MenuEntryActionViewItem, getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { InstanceContext } from './terminalContextMenu.js';
import { getShellProcessTooltip } from './terminalTooltip.js';
import { ActionViewItem, LabelActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalVoiceSession } from '../../terminalContrib/voice/browser/terminalVoice.js';
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { IMenuService, MenuId } from "../../../../platform/actions/common/actions.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { AppServerRemoteError } from "../../../../platform/agentHost/common/appServerError.js";
import { IWorkspaceContextService, type IWorkspaceFolder } from "../../../../platform/workspace/common/workspace.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import { type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, ITerminalService, ITerminalGroupService, type IXtermTerminal } from "../../../services/terminal/browser/terminal.js";

import { TerminalTabbedView } from "./terminalTabbedView.js";
import "./media/terminal.css";
import { h, addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { TerminalProfileQuickpick } from './terminalProfileQuickpick.js';

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
		@ITerminalProfileService private readonly profileService: ITerminalProfileService,
		@ITerminalProfileResolverService private readonly profileResolver: ITerminalProfileResolverService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
		@IEditorService private readonly editors: IEditorService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super(container, options);
		this.terminalService = terminalService;
		this.element.classList.add("ash-terminal-view");
		this.setHeaderVisible(false);
		this.titleActions = this._register(instantiation.createInstance(TerminalTitleActions, this.headerActionsElement));
		this.updateProfiles();
		this._register(profileService.onDidChangeAvailableProfiles(() => this.updateProfiles()));

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
			// A lazily created group service can observe disposal after this view.
			// Let it retire membership before rendering the remaining group panes.
			queueMicrotask(() => { if (!this.isDisposed) this.updateInstances(); });
		}));
		this._register(terminalService.onDidChangeActiveInstance(() => this.updateInstances()));
		this._register(terminalService.onDidChangeInstances(() => this.updateInstances()));
		this._register(groups.onDidChangeGroups(() => this.updateInstances()));
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
			this.layoutGroups();
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

	override focus(): void {
		if (!this.isVisible() || this.isDisposed) return;
		this.setExpanded(true);
		if (!this.groups.activeGroup) {
			const instance = this.groups.groups[0]?.activeInstance;
			if (instance) this.terminalService.setActiveInstance(instance);
		}
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
			await this.terminalService.whenConnected;
			if (this.terminalService.instances.length === 0) {
				// Creation selects the directory before discovering its profiles.
				await this.createTerminal(undefined, false);
			} else {
				await this.profileService.refreshAvailableProfiles(this.terminalService.activeInstance?.dirId);
			}
			if (this.isDisposed) return;
			this.updateProfiles();
		} catch {
			if (this.isDisposed) return;
			this.updateProfiles();
		} finally {
			this.initializing = false;
		}
	}

	public async createTerminal(profileId?: string | { readonly type: 'pick'; }, focus = true, parent?: ITerminalInstance): Promise<void> {
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
			const folders = this.workspaceContext.getWorkspace().folders;
			const activeResource = this.editors.activeEditor?.resource;
			const folder = parent ? folders.find(folder => folder.id === parent.dirId)
				: (activeResource && this.workspaceContext.getWorkspaceFolder(activeResource))
				|| (folders.length === 1 ? folders[0] : await this.commands.executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [{ placeHolder: localize('terminal.selectFolder', 'Select a workspace folder for the terminal.') }]));
			if (!folder || this.isDisposed || !focus && !this.isBodyVisible()) return;
			await this.profileService.refreshAvailableProfiles(folder.id);
			if (this.isDisposed || !focus && !this.isBodyVisible()) return;
			if (typeof profileId === 'object') {
				using picker = this.instantiation.createInstance(TerminalProfileQuickpick);
				profileId = await picker.showAndGetResult('createInstance', folder.id);
				if (profileId === undefined || this.isDisposed) return;
			}
			if (profileId !== undefined && !this.profileService.getAvailableProfiles(folder.id).some(profile => profile.profileId === profileId)
				&& !this.profileService.contributedProfiles.some(profile => `extension:${profile.extensionIdentifier}/${profile.id}` === profileId)) {
				throw new TypeError(localize('terminal.profile.unknown', 'Unknown terminal profile: {0}', profileId));
			}
			const contributed = parent ? undefined : profileId === undefined ? await this.profileService.getContributedDefaultProfile({}) : this.profileService.contributedProfiles.find(profile => profileId === `extension:${profile.extensionIdentifier}/${profile.id}`);
			if (contributed) {
				const provider = this.profileService.getContributedProfileProvider(contributed.extensionIdentifier, contributed.id);
				if (!provider) throw new Error(localize('terminal.profile.providerUnavailable', 'Terminal profile provider is unavailable: {0}', contributed.title));
				await provider.createContributedTerminalProfile({ ...contributed.options, cwd: folder.uri });
				return;
			}
			const profile = profileId === undefined ? this.profileService.getDefaultProfile(undefined, folder.id) : this.profileService.getAvailableProfiles(folder.id).find(profile => profile.profileId === profileId);
			const os = this.processes.operatingSystem;
			if (os === undefined) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
			const shell: IShellLaunchConfig = parent?.shellLaunchConfig?.executable && profileId === parent.profile.profileId ? { ...parent.shellLaunchConfig }
				: profile ? { name: profile.profileName, executable: profile.path, args: profile.args, env: profile.env, icon: profile.icon, color: profile.color } : {};
			if (parent) {
				shell.cwd = parent.cwd;
				if (!shell.cwd) {
					const query = parent.capabilities?.get(TerminalCapability.NaiveCwdDetection);
					// Some execution hosts cannot inspect a process directory. Splitting
					// still has the backend-confirmed launch directory as a fallback.
					try { shell.cwd = await query?.getCwd(); } catch { shell.cwd = undefined; }
				}
				shell.cwd ??= parent.initialCwd;
			}
			await this.profileResolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: getRemoteAuthority(folder.uri), workspaceFolder: folder });
			if (this.isDisposed || !focus && !this.isBodyVisible()) return;
			if (parent && (!this.terminalService.instances.includes(parent) || parent.state !== 'running')) return;
			const created = await this.terminalService.createTerminal({
				dirId: folder.id,
				dimensions: this.activeItem()?.widget.dimensions() ?? DEFAULT_DIMENSIONS,
				title: profile?.overrideName ? profile.profileName : undefined,
				profile: profile?.isAutoDetected ? { type: 'profile', profileId: profile.profileId } : { type: 'custom', name: profile?.profileName ?? shell.name ?? localize('terminal.profile.shell', 'Shell'), path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] },
				env: shell.env, ...(shell.strictEnv === undefined ? {} : { strictEnv: shell.strictEnv }), cwd: shell.cwd, icon: shell.icon, color: shell.color,
			});
			if (parent) {
				if (this.isDisposed || !this.terminalService.instances.includes(parent) || parent.state !== 'running') {
					await this.terminalService.closeTerminal(created);
					return;
				}
				this.groups.joinInstances([parent, created]);
			}
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

	private updateProfiles(): void {
		const profiles = this.profileService.availableProfiles.map(profile => {
			const shell: IShellLaunchConfig = { executable: profile.path, args: profile.args, icon: profile.icon };
			const os = this.processes.operatingSystem;
			if (os !== undefined) this.profileResolver.resolveIcon(shell, os);
			return { ...profile, icon: shell.icon };
		});
		this.titleActions.setProfiles([...profiles, ...this.profileService.contributedProfiles.map(profile => ({ profileId: `extension:${profile.extensionIdentifier}/${profile.id}`, title: profile.title, isDefault: this.profileService.getDefaultProfileName() === profile.title }))]);
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
		await this.terminalService.safeDisposeTerminal(instance);
		if (!this.isDisposed) {
			if (this.terminalService.instances.length === 0) this.layoutService.hidePart("panel");
			else this.terminalService.activeInstance?.xterm?.focus();
		}
	}

	public clearActive(): void {
		this.activeItem()?.widget.clearBuffer();
		this.focus();
	}

	private addInstance(instance: ITerminalInstance): void {
		if (this.items.has(instance) || instance.target === TerminalLocation.Editor) return;
		this.groups.createGroup(instance).attachToElement(this.widgetsElement);
		const item = new TerminalViewItem(
			instance,
			instance.xterm!,
			() => this.updateInstances(),
		);
		this.items.set(instance, item);
	}

	private updateInstances(): void {
		for (const instance of this.items.keys()) {
			if (instance.target === TerminalLocation.Editor) this.removeInstance(instance);
		}
		for (const instance of this.terminalService.instances) this.addInstance(instance);
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
		const instanceSwitcherPlacement = this.groups.groups.length > 1 ? "list" : "title";
		this.titleActions.setActiveInstance(active?.target === TerminalLocation.Editor ? this.groups.activeGroup?.activeInstance : active, instanceSwitcherPlacement);
		for (const group of this.groups.groups) {
			group.attachToElement(this.widgetsElement);
			group.setVisible(this.isBodyVisible() && group === this.groups.activeGroup);
		}
		this.layoutGroups();
	}

	private layoutGroups(): void {
		const style = this.widgetsElement.ownerDocument.defaultView!.getComputedStyle(this.widgetsElement);
		// A queued resize can observe detached panel content with empty computed padding.
		const padding = (value: string): number => parseFloat(value) || 0;
		const width = this.widgetsElement.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight);
		const height = this.widgetsElement.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom);
		for (const group of this.groups.groups) group.layout(Math.max(0, width), Math.max(0, height));
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
		readonly widget: IXtermTerminal,
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
	private readonly inlineActionsContext: IContextKey<boolean>;
	private readonly commandService: ICommandService;
	private profiles: readonly ITerminalProfile[] = [];
	private activeInstance: ITerminalInstance | undefined;
	private singleGroup = true;

	constructor(
		container: HTMLElement,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ICommandService commandService: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
	) {
		super();
		this.commandService = commandService;
		this.creatingContext = TerminalCreatingContext.bindTo(contextKeyService);
		this.hasActiveInstanceContext = TerminalHasActiveInstanceContext.bindTo(contextKeyService);
		this.activeInstanceInTitleContext = TerminalActiveInstanceInTitleContext.bindTo(contextKeyService);
		this.activeInstanceStateContext = TerminalActiveInstanceStateContext.bindTo(contextKeyService);
		this.inlineActionsContext = TerminalViewInlineActionsContext.bindTo(contextKeyService);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('terminal.integrated.tabs')) this.updateContext();
		}));
		this._register(contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set([TerminalContextKeys.tabsNarrow.key]))) this.updateContext();
		}));
		this._register(toDisposable(() => {
			this.inlineActionsContext.reset();
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
		this._register(keybindings.onDidUpdateKeybindings(() => this.toolbar.refresh()));
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
		this.singleGroup = placement === 'title';
		this.updateContext();
		this.toolbar.refresh();
	}

	private updateContext(): void {
		const visible = (setting: string): boolean => {
			const value = this.configuration.getValue<string>(`terminal.integrated.tabs.${setting}`);
			return value === 'always' || value === 'singleTerminal' && this.singleGroup
				|| value === 'singleTerminalOrNarrow' && (this.singleGroup || this.contextKeyService.getValue(TerminalContextKeys.tabsNarrow.key) === true);
		};
		this.contextKeyService.bufferChangeEvents(() => {
			this.activeInstanceInTitleContext.set(this.activeInstance !== undefined && visible('showActiveTerminal'));
			this.inlineActionsContext.set(this.activeInstance !== undefined && visible('showActions'));
			this.hasActiveInstanceContext.set(this.activeInstance !== undefined);
			this.activeInstanceStateContext.set(this.activeInstance?.state ?? 'none');
		});
	}

	private createActionViewItem(action: IAction, contextMenuService: IContextMenuService): ActionViewItem | undefined {
		if (action instanceof MenuItemAction) {
			const binding = this.keybindings.lookupKeybinding(action.id);
			const shortcut = binding && getKeybindingLabel(binding);
			if (shortcut) action = new MenuItemAction({ ...action.item, tooltip: localize('terminal.title.actionKeybinding', '{0} ({1})', action.tooltip, shortcut) }, action.alt, { shouldForwardArgs: true }, this.contextKeyService, this.commandService);
		}
		switch (action.id) {
			case TerminalCommandId.Focus:
				if (!this.activeInstance) return undefined;
				return new ActiveTerminalActionViewItem(action, this.activeInstance, this.menuService, contextMenuService, this.commandService);
			case TerminalCommandId.New:
				return new NewTerminalActionViewItem(
					action,
					new TerminalProfileSelectorAction(action.enabled, (profileId) => this.createTerminalWithProfile(profileId)),
					() => this.profileMenuActions(action),
					contextMenuService,
				);
			default:
				return action instanceof MenuItemAction ? new MenuEntryActionViewItem(action) : undefined;
		}
	}

	private profileMenuActions(action: IAction): IAction[] {
		const instance = this.activeInstance;
		const canSplit = instance?.state === 'running' && !instance.isReadOnly && !instance.shellLaunchConfig?.customPtyImplementation;
		const command = (id: string, label: string, enabled: boolean, ...args: unknown[]): IAction => ({
			id, label, tooltip: label, enabled, run: () => this.commandService.executeCommand(id, ...args),
		});
		return Separator.join(
			[
				command(TerminalCommandId.New, action.label, action.enabled),
				command(TerminalCommandId.Split, localize('terminal.group.splitMenu', 'Split Terminal'), action.enabled && !!canSplit, instance && new InstanceContext(instance)),
			],
			this.profiles.map(profile => terminalProfileMenuAction(profile, profileId => this.createTerminalWithProfile(profileId))),
			canSplit ? [new SubmenuAction('split.profile', localize('terminal.title.splitWithProfile', 'Split Terminal with Profile'),
				this.profiles.filter(profile => !profile.profileId.startsWith('extension:')).map(profile => terminalProfileMenuAction(profile,
					profileId => this.commandService.executeCommand(TerminalCommandId.Split, new InstanceContext(instance), profileId), TerminalCommandId.Split)))] : [],
			[command(TerminalCommandId.SelectDefaultProfile, localize('terminal.title.selectDefaultProfile', 'Select Default Profile'), action.enabled)],
		);
	}

	private createTerminalWithProfile(profileId: unknown): unknown {
		if (typeof profileId !== "string" || !this.profiles.some((profile) => profile.profileId === profileId)) {
			throw new TypeError(`Unknown terminal profile: ${String(profileId)}`);
		}
		return this.commandService.executeCommand(TerminalCommandId.NewWithProfile, profileId);
	}
}

/** Keeps the profile trigger independent while Alt applies to the primary action. */
class NewTerminalActionViewItem extends DropdownWithPrimaryActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		const primary = container.querySelector<HTMLButtonElement>('.ash-dropdown-with-primary-primary button')!;
		this._register(addDisposableListener(primary, 'click', event => {
			if (!event.altKey || !(this.action instanceof MenuItemAction) || !this.action.alt?.enabled) return;
			stopEvent(event);
			event.stopImmediatePropagation();
			void this.action.alt.run();
		}, true));
	}
}

class ActiveTerminalActionViewItem extends LabelActionViewItem {
	constructor(action: IAction, private readonly instance: ITerminalInstance, private readonly menuService: IMenuService, private readonly menus: IContextMenuService, private readonly commands: ICommandService) {
		const tooltip = instance.title === instance.profile.title
			? localize('terminal.title.active', 'Active terminal: {0}', instance.title)
			: localize('terminal.title.activeProfile', 'Active terminal: {0} ({1})', instance.title, instance.profile.title);
		super(action, {
			label: instance.title,
			icon: terminalProfileIcon(instance.profile),
			ariaLabel: tooltip,
			tooltip: tooltip + getShellProcessTooltip(instance, true),
		});
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-terminal-active-action");
		container.dataset.state = this.instance.state;
		const button = container.querySelector<HTMLButtonElement>('button')!;
		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		const open = () => {
			using menu = this.menuService.createMenu(MenuId.TerminalInstanceContext);
			const actions = getFlatContextMenuActions(menu.getActions({ args: [new InstanceContext(this.instance)] }));
			button.setAttribute('aria-expanded', 'true');
			try {
				this.menus.showContextMenu({
					getAnchor: () => button, getActions: () => actions,
					onHide: didCancel => { button.setAttribute('aria-expanded', 'false'); if (didCancel && button.isConnected) button.focus(); },
				});
			} catch (error) { button.setAttribute('aria-expanded', 'false'); throw error; }
		};
		this._register(addDisposableListener(button, 'click', event => {
			stopEvent(event);
			event.stopImmediatePropagation();
			if (event.altKey) void this.commands.executeCommand(TerminalCommandId.Split, new InstanceContext(this.instance));
			else open();
		}, true));
		this._register(addDisposableListener(button, 'contextmenu', event => { stopEvent(event); open(); }));
		this._register(addDisposableListener(button, 'auxclick', event => {
			if (event.button === 1) { stopEvent(event); void this.commands.executeCommand(TerminalCommandId.Kill, new InstanceContext(this.instance)); }
		}));
		this._register(addDisposableListener(button, 'keydown', event => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'F10' && event.shiftKey) { stopEvent(event); open(); }
		}));
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

function terminalProfileMenuAction(profile: ITerminalProfile, createTerminalWithProfile: (profileId: unknown) => unknown, commandId = TerminalCommandId.NewWithProfile): IAction {
	const label = profile.isDefault ? localize('terminal.title.defaultProfile', '{0} (Default)', profile.title) : profile.title;
	return {
		id: `${commandId}.${profile.profileId}`,
		label,
		tooltip: localize('terminal.title.useProfile', 'Use {0}', profile.title),
		icon: terminalProfileIcon(profile),
		enabled: true,
		run: () => createTerminalWithProfile(profile.profileId),
	};
}
