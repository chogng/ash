import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { Keybinding, logicalKey } from '../../../base/common/keybindings.js';
import { localize2 } from '../../../nls.js';
import { Action2, registerAction2, type IAction2Options } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import type { IComposite } from '../../common/composite.js';
import { ViewContainerLocation } from '../../common/views.js';
import { GroupDirection, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, type WorkbenchPartId } from '../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';

const navigationParts = ['editor', 'panel', 'auxiliarybar', 'sidebar', 'agentSidebar'] as const;
const groupDirections = { [Direction.Up]: GroupDirection.UP, [Direction.Down]: GroupDirection.DOWN, [Direction.Left]: GroupDirection.LEFT, [Direction.Right]: GroupDirection.RIGHT };
const oppositeDirections = { [Direction.Up]: GroupDirection.DOWN, [Direction.Down]: GroupDirection.UP, [Direction.Left]: GroupDirection.RIGHT, [Direction.Right]: GroupDirection.LEFT };
const paneLocations = { sidebar: ViewContainerLocation.Sidebar, panel: ViewContainerLocation.Panel, auxiliarybar: ViewContainerLocation.AuxiliaryBar, agentSidebar: ViewContainerLocation.AgentSidebar };

async function focusPart(accessor: ServicesAccessor, part: WorkbenchPartId): Promise<IComposite | undefined> {
	if (part === 'editor') {
		accessor.get(IEditorGroupsService).activeGroup.focus();
		return undefined;
	}
	if (part !== 'sidebar' && part !== 'panel' && part !== 'auxiliarybar' && part !== 'agentSidebar') { return undefined; }
	const panes = accessor.get(IPaneCompositePartService);
	const location = paneLocations[part];
	const active = panes.getActivePaneComposite(location);
	if (active) {
		active.focus();
		return active;
	}
	return panes.openPaneComposite(panes.getLastActivePaneCompositeId(location), location, true);
}

/** Editor splits are visited before crossing the Workbench region boundary. */
class BaseNavigationAction extends Action2 {
	constructor(options: IAction2Options, private readonly direction: Direction) { super(options); }

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const layout = accessor.get(IWorkbenchLayoutService);
		const source = navigationParts.find(part => layout.hasFocus(part));
		if (!source) { return; }
		const groups = accessor.get(IEditorGroupsService);
		if (source === 'editor') {
			const next = groups.findGroup({ direction: groupDirections[this.direction] });
			if (next) {
				next.focus();
				return;
			}
		}
		const target = layout.getVisibleNeighborPart(source, this.direction);
		if (!target) { return; }
		if (target === 'editor') {
			// Enter at the facing edge while retaining the active group's row or column.
			let group = groups.activeGroup;
			let next = groups.findGroup({ direction: oppositeDirections[this.direction] }, group);
			while (next) {
				group = next;
				next = groups.findGroup({ direction: oppositeDirections[this.direction] }, group);
			}
			group.focus();
			return;
		}
		await focusPart(accessor, target);
	}
}

for (const [id, title, direction] of [
	['workbench.action.navigateLeft', localize2('navigateLeft', 'Navigate to the View on the Left'), Direction.Left],
	['workbench.action.navigateRight', localize2('navigateRight', 'Navigate to the View on the Right'), Direction.Right],
	['workbench.action.navigateUp', localize2('navigateUp', 'Navigate to the View Above'), Direction.Up],
	['workbench.action.navigateDown', localize2('navigateDown', 'Navigate to the View Below'), Direction.Down],
] as const) {
	registerAction2(class extends BaseNavigationAction {
		constructor() { super({ id, title, f1: true }, direction); }
	});
}

class BaseFocusAction extends Action2 {
	constructor(options: IAction2Options, private readonly step: -1 | 1) { super(options); }

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const layout = accessor.get(IWorkbenchLayoutService);
		const visible = navigationParts.filter(part => layout.isPartVisible(part));
		if (visible.length === 0) { return; }
		const current = visible.findIndex(part => layout.hasFocus(part));
		const index = current < 0 ? 0 : (current + this.step + visible.length) % visible.length;
		await focusPart(accessor, visible[index]!);
	}
}

registerAction2(class extends BaseFocusAction {
	constructor() {
		super({ id: 'workbench.action.focusNextPart', title: localize2('focusNextPart', 'Focus Next Part'), f1: true, keybinding: { primary: Keybinding.single(logicalKey('F6')) } }, 1);
	}
});

registerAction2(class extends BaseFocusAction {
	constructor() {
		super({ id: 'workbench.action.focusPreviousPart', title: localize2('focusPreviousPart', 'Focus Previous Part'), f1: true, keybinding: { primary: Keybinding.single(logicalKey('F6', { shiftKey: true })) } }, -1);
	}
});
