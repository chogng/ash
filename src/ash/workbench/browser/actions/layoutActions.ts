import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation } from '../../common/configuration.js';
import { IsSessionsWindowContext } from '../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../common/contributions.js';
import { IPreferencesService } from '../../services/preferences/common/preferences.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../common/views.js';
import { IViewsService } from '../../services/views/common/viewsService.js';
import { ToggleSideBarCommandId } from '../parts/titlebar/titlebarActions.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';

for (const alignment of ['top', 'center'] as const) {
	registerAction2(
		class extends Action2 {
			constructor() {
				super({
					id: alignment === 'top' ? 'workbench.action.alignQuickInputTop' : 'workbench.action.alignQuickInputCenter',
					title: alignment === 'top' ? localize2('alignQuickInputTop', 'Align Quick Input Top') : localize2('alignQuickInputCenter', 'Align Quick Input Center'),
					f1: true,
				});
			}
			public override run(accessor: ServicesAccessor): void {
				accessor.get(IQuickInputService).setAlignment(alignment);
			}
		},
	);
}

async function selectItem<T extends IQuickPickItem>(quickInput: IQuickInputService, items: readonly T[], placeholder: string): Promise<T | undefined> {
	using lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<T>());
	picker.items = items;
	picker.placeholder = placeholder;
	picker.ariaLabel = placeholder;
	const selected = await new Promise<T | undefined>(resolve => {
		lifetime.add(picker.onDidAccept(() => resolve(picker.selectedItems[0])));
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
	picker.hide();
	return selected;
}

async function moveView(accessor: ServicesAccessor, id?: unknown): Promise<void> {
	if (id !== undefined && typeof id !== 'string') throw new TypeError('Expected a view ID');
	const descriptors = accessor.get(IViewDescriptorService);
	const views = accessor.get(IViewsService);
	const quickInput = accessor.get(IQuickInputService);
	let view = typeof id === 'string' ? descriptors.getViewDescriptorById(id) : null;
	if (!view) {
		const candidates = descriptors.viewContainers
			.flatMap(container => descriptors.getViewContainerModel(container.id).allViewDescriptors)
			.filter(view => view.canMoveView)
			.map(view => ({
				label: view.localizationKey ? localize(view.localizationKey, view.title) : view.title,
				view,
			}));
		view = (await selectItem(quickInput, candidates, localize('views.selectView', 'Select a view to move')))?.view ?? null;
	}
	if (!view?.canMoveView) return;
	type Destination = { readonly containerId: string } | { readonly location: ViewContainerLocation };
	const destinations: { label: string; description?: string; destination: Destination }[] = [
		{
			label: localize('views.newSidebarEntry', 'New Primary Side Bar Entry'),
			destination: { location: ViewContainerLocation.Sidebar },
		},
		{
			label: localize('views.newAuxiliaryEntry', 'New Secondary Side Bar Entry'),
			destination: { location: ViewContainerLocation.AuxiliaryBar },
		},
		{
			label: localize('views.newPanelEntry', 'New Panel Entry'),
			destination: { location: ViewContainerLocation.Panel },
		},
		...descriptors.viewContainers
			.filter(container => !container.rejectAddedViews && container.location !== ViewContainerLocation.AgentSidebar)
			.map(container => ({
				label: container.localizationKey ? localize(container.localizationKey, container.title) : container.title,
				destination: { containerId: container.id },
			})),
	];
	const title = view.localizationKey ? localize(view.localizationKey, view.title) : view.title;
	const selected = await selectItem(quickInput, destinations, localize('views.selectDestination', "Move '{0}' to", title));
	if (!selected) return;
	if ('containerId' in selected.destination) descriptors.moveViewsToContainer([view], descriptors.getViewContainerById(selected.destination.containerId)!);
	else descriptors.moveViewToLocation(view, selected.destination.location);
	await views.openView(view.id, true);
}

registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.moveView',
				title: localize2('views.moveViewCommand', 'Move View'),
				f1: true,
			});
		}
		public override run(accessor: ServicesAccessor): Promise<void> {
			return moveView(accessor);
		}
	},
);

registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.moveFocusedView',
				title: localize2('views.moveFocusedViewCommand', 'Move Focused View'),
				f1: true,
			});
		}
		public override run(accessor: ServicesAccessor, id?: unknown): Promise<void> {
			return moveView(accessor, id ?? accessor.get(IViewsService).getFocusedView()?.id);
		}
	},
);

registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.resetViewLocations',
				title: localize2('views.resetViewLocations', 'Reset View Locations'),
				f1: true,
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const descriptors = accessor.get(IViewDescriptorService);
			descriptors.reset();
			const views = accessor.get(IViewsService);
			for (const location of [ViewContainerLocation.Sidebar, ViewContainerLocation.Panel, ViewContainerLocation.AuxiliaryBar]) {
				const container = descriptors.getDefaultViewContainer(location);
				if (container) await views.openViewContainer(container.id);
			}
		}
	},
);

registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.resetFocusedViewLocation',
				title: localize2('views.resetFocusedViewLocation', 'Reset Focused View Location'),
				f1: true,
			});
		}
		public override async run(accessor: ServicesAccessor, id?: unknown): Promise<void> {
			if (id !== undefined && typeof id !== 'string') throw new TypeError('Expected a view ID');
			const views = accessor.get(IViewsService);
			const descriptors = accessor.get(IViewDescriptorService);
			const view = typeof id === 'string' ? descriptors.getViewDescriptorById(id) : views.getFocusedView();
			const container = view && descriptors.getDefaultContainerById(view.id);
			if (view && container) {
				descriptors.moveViewsToContainer([view], container);
				await views.openView(view.id, true);
			}
		}
	},
);

export class ConfigureEditorAction extends Action2 {
	static readonly ID = 'workbench.action.configureEditor';

	constructor() {
		super({
			id: ConfigureEditorAction.ID,
			title: localize2('workbench.configureEditors', 'Configure Editors'),
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openSettings({ query: 'workbench.editor' });
	}
}
registerAction2(ConfigureEditorAction);

export const ActivityBarContextMenu = MenuId.for('ActivityBarContext');
export const ActivityBarItemContextMenu = MenuId.for('ActivityBarItemContext');
const moveViewContainerMenu = MenuId.for('MoveViewContainer');

registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.configureActivityBarKeybinding',
				title: localize2('quickAccess.configureKeybinding', 'Configure Keybinding'),
				menu: { id: ActivityBarItemContextMenu, group: '1_keybinding' },
			});
		}

		override run(accessor: ServicesAccessor, id: unknown): Promise<void> | undefined {
			if (typeof id !== 'string') throw new TypeError('Expected a view container ID');
			if (!accessor.get(IViewDescriptorService).getViewContainerById(id)) return;
			return accessor.get(IPreferencesService).openGlobalKeybindingSettings(false, { query: `@command:${id}` });
		}
	},
);

for (const [location, title] of [
	[ViewContainerLocation.Sidebar, localize2('workbench.moveViewContainer.sidebar', 'Primary Side Bar')],
	[ViewContainerLocation.AuxiliaryBar, localize2('workbench.moveViewContainer.auxiliarybar', 'Secondary Side Bar')],
	[ViewContainerLocation.Panel, localize2('workbench.moveViewContainer.panel', 'Panel')],
] as const) {
	registerAction2(
		class extends Action2 {
			constructor() {
				super({
					id: `workbench.action.moveViewContainer.${location}`,
					title,
					menu: {
						id: moveViewContainerMenu,
						when: ContextKeyExpr.notEquals('viewContainerLocation', location),
						group: '1_move',
					},
				});
			}

			override async run(accessor: ServicesAccessor, id: unknown): Promise<void> {
				if (typeof id !== 'string') throw new TypeError('Expected a view container ID');
				const descriptors = accessor.get(IViewDescriptorService);
				const container = descriptors.getViewContainerById(id);
				if (!container) return;
				const views = accessor.get(IViewsService);
				const wasVisible = views.isViewContainerVisible(id);
				descriptors.moveViewContainerToLocation(container, location, undefined, 'activityBar');
				const fallback = wasVisible && descriptors.getDefaultViewContainer(container.location);
				if (fallback) await views.openViewContainer(fallback.id);
				await views.openViewContainer(id, true);
			}
		},
	);
}
MenusRegistry.appendMenuItem(ActivityBarItemContextMenu, {
	submenu: moveViewContainerMenu,
	title: localize2('workbench.moveViewContainer', 'Move To'),
	group: '2_move',
});
MenusRegistry.appendMenuItem(MenuId.ViewContainerTitleContext, {
	submenu: moveViewContainerMenu,
	title: localize2('workbench.moveViewContainer', 'Move To'),
	group: '2_move',
});
const activityBarSizeMenu = MenuId.for('ActivityBarSize');
const locationKey = `config.${WorkbenchConfiguration.activityBarLocation}`;
const compactKey = `config.${WorkbenchConfiguration.activityBarCompact}`;
const sideKey = `config.${WorkbenchConfiguration.sideBarLocation}`;

// These values are derived menu context, owned by the window. Configuration
// remains authoritative and its change event also covers Settings and restore.
export class LayoutActionsContext extends Disposable {
	constructor(configuration: IConfigurationService, context: IContextKeyService) {
		super();
		const settings = [WorkbenchConfiguration.activityBarLocation, WorkbenchConfiguration.activityBarCompact, WorkbenchConfiguration.sideBarLocation];
		const update = () =>
			context.bufferChangeEvents(() => {
				for (const setting of settings) context.setContext(`config.${setting}`, configuration.getValue<string | boolean>(setting));
			});
		update();
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (settings.some(setting => event.affectsConfiguration(setting))) update();
			}),
		);
		this._register(
			toDisposable(() =>
				context.bufferChangeEvents(() => {
					for (const setting of settings) context.removeContext(`config.${setting}`);
				}),
			),
		);
	}
}

registerWorkbenchContribution(
	'workbench.contrib.layoutActionsContext',
	WorkbenchPhase.BlockStartup,
	accessor => new LayoutActionsContext(accessor.get(IConfigurationService), accessor.get(IContextKeyService)),
);

let positionOrder = 0;
for (const [position, suffix, shortTitle, title] of [
	[ActivityBarPosition.DEFAULT, 'default', localize2('workbench.activityBarPositionDefault', 'Default'), localize2('workbench.activityBarCommand.default', 'Move Activity Bar to Side')],
	[ActivityBarPosition.TOP, 'top', localize2('workbench.activityBarPositionTop', 'Top'), localize2('workbench.activityBarCommand.top', 'Move Activity Bar to Top')],
	[ActivityBarPosition.BOTTOM, 'bottom', localize2('workbench.activityBarPositionBottom', 'Bottom'), localize2('workbench.activityBarCommand.bottom', 'Move Activity Bar to Bottom')],
	[ActivityBarPosition.HIDDEN, 'hide', localize2('workbench.activityBarPositionHidden', 'Hidden'), localize2('workbench.activityBarCommand.hide', 'Hide Activity Bar')],
] as const) {
	const desc = {
		id: `workbench.action.activityBarLocation.${suffix}`,
		title,
		shortTitle,
		toggled: ContextKeyExpr.equals(locationKey, position),
		f1: true,
		precondition: IsSessionsWindowContext.isEqualTo(false),
	};
	registerAction2(
		class extends Action2 {
			constructor() {
				super(desc);
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return accessor.get(IConfigurationService).updateValue(WorkbenchConfiguration.activityBarLocation, position);
			}
		},
	);
	MenusRegistry.appendMenuItem(MenuId.ActivityBarPositionMenu, {
		command: { ...desc, title: desc.shortTitle },
		group: '1_position',
		order: positionOrder++,
	});
}

for (const compact of [false, true]) {
	const suffix = compact ? 'compact' : 'default';
	const desc = {
		id: `workbench.action.activityBar.size.${suffix}`,
		title: compact ? localize2('workbench.activityBarSizeCommand.compact', 'Use Compact Activity Bar') : localize2('workbench.activityBarSizeCommand.default', 'Use Default Activity Bar Size'),
		shortTitle: compact ? localize2('workbench.activityBarSizeCompact', 'Compact') : localize2('workbench.activityBarSizeDefault', 'Default'),
		toggled: ContextKeyExpr.equals(compactKey, compact),
		f1: true,
		precondition: IsSessionsWindowContext.isEqualTo(false),
	};
	registerAction2(
		class extends Action2 {
			constructor() {
				super(desc);
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return accessor.get(IConfigurationService).updateValue(WorkbenchConfiguration.activityBarCompact, compact);
			}
		},
	);
	MenusRegistry.appendMenuItem(activityBarSizeMenu, {
		command: { ...desc, title: desc.shortTitle },
		group: '1_size',
		order: compact ? 1 : 0,
	});
}

for (const side of ['left', 'right'] as const) {
	registerAction2(
		class extends Action2 {
			constructor() {
				super({
					id: side === 'left' ? 'workbench.action.moveSideBarLeft' : 'workbench.action.moveSideBarRight',
					title:
						side === 'left' ? localize2('workbench.movePrimarySideBarLeft', 'Move Primary Side Bar Left') : localize2('workbench.movePrimarySideBarRight', 'Move Primary Side Bar Right'),
					f1: true,
					precondition: IsSessionsWindowContext.isEqualTo(false),
					menu: [MenuId.ViewContainerTitleContext, ActivityBarContextMenu].map(id => ({
						id,
						group: '3_layout',
						order: 4,
						when: ContextKeyExpr.and(
							ContextKeyExpr.notEquals(sideKey, side),
							id === MenuId.ViewContainerTitleContext ? ContextKeyExpr.equals('viewContainerLocation', 'sidebar') : undefined,
						),
					})),
				});
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return accessor.get(IConfigurationService).updateValue(WorkbenchConfiguration.sideBarLocation, side);
			}
		},
	);
}

export class ToggleSidebarPositionAction extends Action2 {
	static readonly ID = 'workbench.action.toggleSidebarPosition';
	constructor() {
		super({
			id: ToggleSidebarPositionAction.ID,
			title: localize2('workbench.togglePrimarySideBarPosition', 'Toggle Primary Side Bar Position'),
			f1: true,
			precondition: IsSessionsWindowContext.isEqualTo(false),
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		return configuration.updateValue(WorkbenchConfiguration.sideBarLocation, configuration.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation) === 'left' ? 'right' : 'left');
	}
}
registerAction2(ToggleSidebarPositionAction);

for (const id of [MenuId.ViewContainerTitleContext, ActivityBarContextMenu]) {
	const sidebar = id === MenuId.ViewContainerTitleContext ? ContextKeyExpr.equals('viewContainerLocation', 'sidebar') : undefined;
	MenusRegistry.appendMenuItem(id, {
		submenu: MenuId.ActivityBarPositionMenu,
		title: localize2('workbench.activityBarPosition', 'Activity Bar Position'),
		group: '3_layout',
		order: 2,
		when: sidebar,
	});
	MenusRegistry.appendMenuItem(id, {
		submenu: activityBarSizeMenu,
		title: localize2('workbench.activityBarSize', 'Activity Bar Size'),
		group: '3_layout',
		order: 3,
		when: ContextKeyExpr.and(sidebar, ContextKeyExpr.equals(locationKey, ActivityBarPosition.DEFAULT)),
	});
}

MenusRegistry.appendMenuItem(ActivityBarContextMenu, {
	command: {
		id: ToggleSideBarCommandId,
		title: localize2({ bundle: 'ash.actions', key: 'hidePrimarySidebar' }, 'Hide Primary Side Bar'),
	},
	group: '3_layout',
	order: 5,
});
