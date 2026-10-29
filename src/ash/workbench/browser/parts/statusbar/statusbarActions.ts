import type { IAction } from '../../../../base/common/actions.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { StatusBarFocused } from '../../../common/contextkeys.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import type { StatusbarViewModel } from './statusbarModel.js';

/** The checked state is read from the model, never copied into the action. */
export class ToggleStatusbarEntryVisibilityAction implements IAction {
	readonly tooltip = '';
	readonly enabled = true;

	constructor(
		readonly id: string,
		readonly label: string,
		private readonly model: StatusbarViewModel,
	) { }

	get checked(): boolean {
		return !this.model.isHidden(this.id);
	}

	run(): void {
		if (this.checked) this.model.hide(this.id);
		else this.model.show(this.id);
	}
}

export class HideStatusbarEntryAction implements IAction {
	readonly tooltip = '';
	readonly enabled = true;
	readonly label: string;

	constructor(
		readonly id: string,
		name: string,
		private readonly model: StatusbarViewModel,
	) {
		this.label = localize('statusbar.hideEntry', "Hide '{0}'", name);
	}

	run(): void {
		this.model.hide(this.id);
	}
}

function activePart(accessor: ServicesAccessor) {
	return accessor.get(IStatusbarService).getPart(accessor.get(ILayoutService).activeContainer);
}

registerAction2(class FocusStatusBarAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.focusStatusBar',
			get title() { return localize2('statusbar.focus', 'Focus Status Bar'); },
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		activePart(accessor).focus();
	}
});

for (const direction of ['Previous', 'Next'] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.statusBar.focus${direction}`,
				get title() {
					return direction === 'Next'
						? localize2('statusbar.focusNext', 'Focus Next Status Bar Entry')
						: localize2('statusbar.focusPrevious', 'Focus Previous Status Bar Entry');
				},
				keybinding: {
					primary: Keybinding.single(logicalKey(direction === 'Next' ? 'ArrowRight' : 'ArrowLeft')),
					secondary: [Keybinding.single(logicalKey(direction === 'Next' ? 'ArrowDown' : 'ArrowUp'))],
					when: StatusBarFocused.isEqualTo(true),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const part = activePart(accessor);
			if (direction === 'Next') part.focusNextEntry();
			else part.focusPreviousEntry();
		}
	});
}

for (const edge of ['First', 'Last'] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.statusBar.focus${edge}`,
				get title() {
					return edge === 'First'
						? localize2('statusbar.focusFirst', 'Focus First Status Bar Entry')
						: localize2('statusbar.focusLast', 'Focus Last Status Bar Entry');
				},
				keybinding: {
					primary: Keybinding.single(logicalKey(edge === 'First' ? 'Home' : 'End')),
					when: StatusBarFocused.isEqualTo(true),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const part = activePart(accessor);
			part.focus(false);
			if (edge === 'First') part.focusNextEntry();
			else part.focusPreviousEntry();
		}
	});
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.statusBar.clearFocus',
			get title() { return localize2('statusbar.clearFocus', 'Clear Status Bar Focus'); },
			keybinding: {
				primary: Keybinding.single(logicalKey('Escape')),
				when: StatusBarFocused.isEqualTo(true),
			},
		});
	}
	override run(accessor: ServicesAccessor): void {
		const part = activePart(accessor);
		if (part.isEntryFocused()) part.focus(false);
		else accessor.get(ILayoutService).focus();
	}
});
