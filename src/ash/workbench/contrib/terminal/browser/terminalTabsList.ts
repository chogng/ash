import { addDisposableListener } from '../../../../base/browser/dom.js';
import { TabList, type TabListDropPosition } from '../../../../base/browser/ui/tablist/tabList.js';
import { Emitter } from '../../../../base/common/event.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { TerminalActiveInstanceStateContext, TerminalHasActiveInstanceContext } from '../common/terminalContextKey.js';
import { ITerminalService, type ITerminalInstance } from './terminal.js';
import { openContextMenu } from './terminalContextMenu.js';
import { terminalProfileIcon } from './terminalIcon.js';

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
	) {
		super(parent, {
			ariaLabel: localize('terminal.tabs.instances', 'Terminal instances'),
			orientation: 'vertical', draggable: true, closeActionIcon: Lxicon.trash,
			onActivate: instance => { this.terminals.setActiveInstance(instance); this.focused.fire(); },
			onClose: instance => { void this.terminals.closeTerminal(instance).catch(() => { }); },
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
		this._register(terminals.onDidChangeActiveInstance(() => this.refresh()));
		this.refresh();
	}

	public refresh(): void {
		for (const instance of this.instanceListeners.keys()) {
			if (!this.terminals.instances.includes(instance)) this.instanceListeners.deleteAndDispose(instance);
		}
		for (const instance of this.terminals.instances) {
			if (!this.instanceListeners.has(instance)) this.instanceListeners.set(instance, instance.onDidChangeState(() => this.refresh()));
		}
		this.setTabs(this.terminals.instances.map(instance => ({
			id: instance.id, value: instance, label: instance.title, tooltip: instance.title,
			icon: terminalProfileIcon(instance.profile), state: instance.state, tabId: `${instance.id}-tab`,
			renderLabel: (container: HTMLElement) => {
				const label = new IconLabel(container, { label: instance.title, icon: terminalProfileIcon(instance.profile) });
				this.labels.set(instance, label);
				return toDisposable(() => { this.labels.delete(instance); label.dispose(); });
			},
		})), this.terminals.activeInstance?.id);
		for (const [instance, label] of this.labels) {
			label.setLabel(instance.title, undefined, { icon: terminalProfileIcon(instance.profile) });
			label.iconElement.style.color = instance.profile.color ? `var(${colorCssVariable(instance.profile.color)})` : '';
		}
	}

	public layout(_height?: number, width = this.element.clientWidth): void {
		this.hasLabels = width >= TerminalTabsListSizes.MidpointViewWidth;
		this.element.classList.toggle('ash-terminal-tabs-narrow', !this.hasLabels);
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
