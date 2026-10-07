import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize2 } from '../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation } from '../../common/configuration.js';
import { IsSessionsWindowContext } from '../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../common/contributions.js';

export const ActivityBarContextMenu = MenuId.for('ActivityBarContext');
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
		const update = () => context.bufferChangeEvents(() => {
			for (const setting of settings) context.setContext(`config.${setting}`, configuration.getValue<string | boolean>(setting));
		});
		update();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (settings.some(setting => event.affectsConfiguration(setting))) update();
		}));
		this._register(toDisposable(() => context.bufferChangeEvents(() => {
			for (const setting of settings) context.removeContext(`config.${setting}`);
		})));
	}
}

registerWorkbenchContribution('workbench.contrib.layoutActionsContext', WorkbenchPhase.BlockStartup,
	accessor => new LayoutActionsContext(accessor.get(IConfigurationService), accessor.get(IContextKeyService)));

let positionOrder = 0;
for (const [position, suffix, shortTitle, title] of [
	[ActivityBarPosition.DEFAULT, 'default', localize2('workbench.activityBarPositionDefault', 'Default'), localize2('workbench.activityBarCommand.default', 'Move Activity Bar to Side')],
	[ActivityBarPosition.TOP, 'top', localize2('workbench.activityBarPositionTop', 'Top'), localize2('workbench.activityBarCommand.top', 'Move Activity Bar to Top')],
	[ActivityBarPosition.BOTTOM, 'bottom', localize2('workbench.activityBarPositionBottom', 'Bottom'), localize2('workbench.activityBarCommand.bottom', 'Move Activity Bar to Bottom')],
	[ActivityBarPosition.HIDDEN, 'hide', localize2('workbench.activityBarPositionHidden', 'Hidden'), localize2('workbench.activityBarCommand.hide', 'Hide Activity Bar')],
] as const) {
	const desc = {
		id: `workbench.action.activityBarLocation.${suffix}`,
		title, shortTitle,
		toggled: ContextKeyExpr.equals(locationKey, position),
		f1: true,
		precondition: IsSessionsWindowContext.isEqualTo(false),
	};
	registerAction2(class extends Action2 {
		constructor() { super(desc); }
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IConfigurationService).updateValue(WorkbenchConfiguration.activityBarLocation, position);
		}
	});
	MenusRegistry.appendMenuItem(MenuId.ActivityBarPositionMenu, { command: { ...desc, title: desc.shortTitle }, group: '1_position', order: positionOrder++ });
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
	registerAction2(class extends Action2 {
		constructor() { super(desc); }
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IConfigurationService).updateValue(WorkbenchConfiguration.activityBarCompact, compact);
		}
	});
	MenusRegistry.appendMenuItem(activityBarSizeMenu, { command: { ...desc, title: desc.shortTitle }, group: '1_size', order: compact ? 1 : 0 });
}

for (const side of ['left', 'right'] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: side === 'left' ? 'workbench.action.moveSideBarLeft' : 'workbench.action.moveSideBarRight',
				title: side === 'left' ? localize2('workbench.movePrimarySideBarLeft', 'Move Primary Side Bar Left') : localize2('workbench.movePrimarySideBarRight', 'Move Primary Side Bar Right'),
				f1: true,
				precondition: IsSessionsWindowContext.isEqualTo(false),
				menu: [MenuId.SidebarTitle, ActivityBarContextMenu].map(id => ({ id, group: '3_layout', order: 1, when: ContextKeyExpr.notEquals(sideKey, side) })),
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IConfigurationService).updateValue(WorkbenchConfiguration.sideBarLocation, side);
		}
	});
}

export class ToggleSidebarPositionAction extends Action2 {
	static readonly ID = 'workbench.action.toggleSidebarPosition';
	constructor() {
		super({ id: ToggleSidebarPositionAction.ID, title: localize2('workbench.togglePrimarySideBarPosition', 'Toggle Primary Side Bar Position'), f1: true, precondition: IsSessionsWindowContext.isEqualTo(false) });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		return configuration.updateValue(WorkbenchConfiguration.sideBarLocation, configuration.getValue<SideBarLocation>(WorkbenchConfiguration.sideBarLocation) === 'left' ? 'right' : 'left');
	}
}
registerAction2(ToggleSidebarPositionAction);

for (const id of [MenuId.SidebarTitle, ActivityBarContextMenu]) {
	MenusRegistry.appendMenuItem(id, { submenu: MenuId.ActivityBarPositionMenu, title: localize2('workbench.activityBarPosition', 'Activity Bar Position'), group: '3_layout', order: 2 });
	MenusRegistry.appendMenuItem(id, { submenu: activityBarSizeMenu, title: localize2('workbench.activityBarSize', 'Activity Bar Size'), group: '3_layout', order: 3, when: ContextKeyExpr.equals(locationKey, ActivityBarPosition.DEFAULT) });
}
