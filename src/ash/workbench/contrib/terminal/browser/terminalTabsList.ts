import { addDisposableListener } from '../../../../base/browser/dom.js';
import { TabList, type TabListDropPosition } from '../../../../base/browser/ui/tablist/tabList.js';
import { Emitter } from '../../../../base/common/event.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { killTerminalIcon } from './terminalIcons.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getShellProcessTooltip } from './terminalTooltip.js';
import { localize } from '../../../../nls.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { TerminalActiveInstanceStateContext, TerminalHasActiveInstanceContext } from '../common/terminalContextKey.js';
import { ITerminalService, ITerminalGroupService, type ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import { InstanceContext, openContextMenu } from './terminalContextMenu.js';
import { terminalProfileIcon } from './terminalIcon.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';
import { EnvironmentVariableInfoChangesActive } from './environmentVariableInfo.js';
import { TerminalCommandId } from '../common/terminal.js';

export const enum TerminalTabsListSizes {
	NarrowViewWidth = 46,
	WideViewMinimumWidth = 80,
	DefaultWidth = 120,
	MidpointViewWidth = 63,
	MaximumWidth = 500,
}

/** Owns terminal row identity, input and rendering; geometry belongs to the tabbed view. */
export class TerminalTabList extends TabList<ITerminalInstance> {
	private readonly instanceListeners = this._register(new DisposableMap<ITerminalInstance, IDisposable>());
	private readonly labels = new Map<ITerminalInstance, IconLabel>();
	private readonly branches = new Map<ITerminalInstance, HTMLElement>();
	private readonly focused = this._register(new Emitter<void>());
	public readonly onDidFocusInstance = this.focused.event;
	private draggedTerminal: ITerminalInstance | undefined;
	private ownsMenu = false;
	private hasLabels = true;
	public get hasText(): boolean { return this.hasLabels; }

	constructor(
		parent: HTMLElement,
		@ITerminalService private readonly terminals: ITerminalService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IEnvironmentVariableService private readonly environmentVariables: IEnvironmentVariableService,
		@ICommandService private readonly commands: ICommandService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
	) {
		super(parent, {
			ariaLabel: localize('terminal.tabs.instances', 'Terminal instances'),
			orientation: 'vertical', draggable: true, closeActionIcon: killTerminalIcon,
			onActivate: instance => { this.terminals.setActiveInstance(instance); this.focused.fire(); },
			onClose: instance => { void this.closeTerminal(instance).catch(() => { }); },
			dragAndDrop: {
				canDrop: () => this.draggedTerminal !== undefined,
				onDragStart: instance => { this.draggedTerminal = instance; },
				onDrop: (target, position) => { if (this.draggedTerminal) this.moveTerminal(this.draggedTerminal, target, position); },
				onDragEnd: () => { this.draggedTerminal = undefined; },
			},
		});
		this.element.classList.add('ash-terminal-tabs');
		const scope = this._register(contextKeys.createScoped(this.element));
		const hasInstance = TerminalHasActiveInstanceContext.bindTo(scope);
		const state = TerminalActiveInstanceStateContext.bindTo(scope);
		const menu = this._register(menuService.createMenu(MenuId.TerminalInstanceContext, scope));
		const show = (target: HTMLElement, event: MouseEvent): void => {
			const instance = this.terminals.instances.find(instance => `${instance.id}-tab` === target.id);
			if (!instance) return;
			hasInstance.set(true);
			state.set(instance.state);
			openContextMenu(parent.ownerDocument.defaultView!, event, instance, menu, this.contextMenu);
			this.ownsMenu = true;
		};
		this._register(addDisposableListener(this.element, 'contextmenu', event => {
			const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
			if (tab) show(tab, event);
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
			const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
			if (!tab) return;
			event.preventDefault();
			event.stopPropagation();
			const bounds = tab.getBoundingClientRect();
			const targetWindow = parent.ownerDocument.defaultView!;
			show(tab, new targetWindow.MouseEvent('contextmenu', { clientX: bounds.left, clientY: bounds.bottom }));
		}));
		this._register(contextMenu.onDidHideContextMenu(() => { this.ownsMenu = false; }));
		this._register(toDisposable(() => {
			this.draggedTerminal = undefined;
			if (this.ownsMenu) contextMenu.hideContextMenu();
			this.ownsMenu = false;
		}));
		this._register(terminals.onDidChangeInstances(() => this.refresh()));
		this._register(groups.onDidChangeGroups(() => this.refresh()));
		this._register(environmentVariables.onDidChangeCollections(() => this.refresh()));
		this._register(terminals.onDidChangeActiveInstance(() => this.refresh()));
		this.refresh();
	}

	public refresh(): void {
		for (const instance of this.instanceListeners.keys()) {
			if (!this.terminals.instances.includes(instance)) this.instanceListeners.deleteAndDispose(instance);
		}
		for (const instance of this.terminals.instances) {
			if (!this.instanceListeners.has(instance)) {
				const lifetime = new DisposableStore();
				lifetime.add(instance.onDidChangeState(() => this.refresh()));
				if (instance.statusList) lifetime.add(instance.statusList.onDidChangePrimaryStatus(() => this.refresh()));
				this.instanceListeners.set(instance, lifetime);
			}
		}
		const environmentInfo = new EnvironmentVariableInfoChangesActive(this.environmentVariables.collections);
		// Group membership owns adjacency and pane order; the process list alone can interleave groups.
		const positions = new Map(this.terminals.instances.map((instance, index) => [instance, index]));
		const firstPosition = (group: typeof this.groups.groups[number]): number =>
			Math.min(...group.terminalInstances.map(instance => positions.get(instance) ?? Number.POSITIVE_INFINITY));
		const orderedGroups = [...this.groups.groups].sort((left, right) => firstPosition(left) - firstPosition(right));
		const rows = orderedGroups.flatMap(group => group.terminalInstances);
		const active = this.terminals.activeInstance;
		this.setTabs(rows.map(instance => {
			const group = this.groups.getGroupForInstance(instance)!;
			return {
				id: instance.id, value: instance, label: instance.title, tooltip: instance.title + getShellProcessTooltip(instance, true, environmentInfo),
				ariaDescription: group.terminalInstances.length > 1
					? localize('terminal.tabs.splitDescription', 'Split {0} of {1} in terminal group {2}', group.terminalInstances.indexOf(instance) + 1, group.terminalInstances.length, orderedGroups.indexOf(group) + 1)
					: undefined,
				icon: terminalProfileIcon(instance.profile), state: instance.state, tabId: `${instance.id}-tab`,
				actions: {
					ariaLabel: localize('terminal.title.actions', 'Terminal actions'),
					items: [{
						id: TerminalCommandId.Split,
						label: localize('terminal.group.splitMenu', 'Split Terminal'),
						tooltip: localize('terminal.group.splitMenu', 'Split Terminal'),
						icon: Lxicon.splitHorizontal,
						enabled: instance.state === 'running' && !instance.isReadOnly && !instance.shellLaunchConfig?.customPtyImplementation,
						// Row actions must target their own terminal, even when another pane has focus.
						run: () => this.commands.executeCommand(TerminalCommandId.Split, new InstanceContext(instance)),
					}],
				},
				renderLabel: (container: HTMLElement) => {
					const branch = container.ownerDocument.createElement('span');
					branch.className = 'ash-terminal-group-branch';
					branch.setAttribute('aria-hidden', 'true');
					container.append(branch);
					this.branches.set(instance, branch);
					const label = new IconLabel(container, { label: instance.title, icon: terminalProfileIcon(instance.profile) });
					this.labels.set(instance, label);
					return toDisposable(() => { this.branches.delete(instance); this.labels.delete(instance); label.dispose(); });
				},
			};
		}), active && rows.includes(active) ? active.id : undefined);
		for (const [instance, label] of this.labels) {
			label.setLabel(instance.title, undefined, { icon: terminalProfileIcon(instance.profile) });
			label.iconElement.style.color = instance.profile.color ? `var(${colorCssVariable(instance.profile.color)})` : '';
			const branch = this.branches.get(instance)!;
			const members = this.groups.getGroupForInstance(instance)!.terminalInstances;
			const index = members.indexOf(instance);
			branch.hidden = members.length < 2;
			branch.textContent = members.length < 2 ? '' : index === 0 ? '┌' : index === members.length - 1 ? '└' : '├';
		}
	}

	public layout(_height?: number, width = this.element.clientWidth): void {
		this.hasLabels = width >= TerminalTabsListSizes.MidpointViewWidth;
		this.element.classList.toggle('ash-terminal-tabs-narrow', !this.hasLabels);
	}

	private async closeTerminal(instance: ITerminalInstance): Promise<void> {
		const document = this.element.ownerDocument;
		const focusSource = document.activeElement;
		await this.terminals.safeDisposeTerminal(instance);
		if (this.isDisposed) return;
		// Closing removes the pressed row button. Restore terminal input unless
		// the user moved focus to another connected control while release awaited.
		if (document.activeElement === focusSource || document.activeElement === document.body && !focusSource?.isConnected) {
			this.focused.fire();
		}
	}

	private moveTerminal(source: ITerminalInstance, target: ITerminalInstance | undefined, position: TabListDropPosition): void {
		if (source === target) return;
		const instances = this.terminals.instances;
		const sourceIndex = instances.indexOf(source);
		if (sourceIndex < 0) return;
		const targetIndex = target === undefined ? instances.length : instances.indexOf(target);
		const insertion = targetIndex < 0 ? instances.length - 1 : position === 'before' ? targetIndex : targetIndex + 1;
		this.terminals.moveTerminal(source, insertion > sourceIndex ? insertion - 1 : insertion);
	}
}
