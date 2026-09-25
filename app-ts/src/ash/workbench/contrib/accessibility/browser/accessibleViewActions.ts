import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { AccessibleViewType, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

registerAction2(class OpenAccessibilityHelpAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibilityHelp',
			title: localizedString('ash', 'accessibility.openHelp', 'Open Accessibility Help'),
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('F1', { altKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).show(AccessibleViewType.Help);
	}
});

registerAction2(class OpenAccessibleViewAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibleView',
			title: localizedString('ash', 'accessibility.openView', 'Open Accessible View'),
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('F2', { altKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).show(AccessibleViewType.View);
	}
});
