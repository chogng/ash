import { localize2 } from '../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { AccessibleViewType, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AccessibilityCommandId } from '../common/accessibilityCommands.js';
import { accessibilityHelpIsShown, accessibleViewIsShown, accessibleViewVerbosityEnabled } from './accessibilityConfiguration.js';

registerAction2(class OpenAccessibilityHelpAction extends Action2 {
	constructor() {
		super({
			id: AccessibilityCommandId.OpenAccessibilityHelp,
			title: localize2({ bundle: 'ash', key: 'accessibility.openHelp' }, 'Open Accessibility Help'),
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
			id: AccessibilityCommandId.OpenAccessibleView,
			title: localize2({ bundle: 'ash', key: 'accessibility.openView' }, 'Open Accessible View'),
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('F2', { altKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).show(AccessibleViewType.View);
	}
});

registerAction2(class DisableVerbosityHintAction extends Action2 {
	constructor() {
		super({
			id: AccessibilityCommandId.DisableVerbosityHint,
			title: localize2('accessibility.disableHint', 'Disable Accessibility Help Hint'),
			f1: true,
			precondition: ContextKeyExpr.and(
				ContextKeyExpr.or(accessibilityHelpIsShown.isEqualTo(true), accessibleViewIsShown.isEqualTo(true)),
				accessibleViewVerbosityEnabled.isEqualTo(true),
			),
			keybinding: { primary: Keybinding.single(logicalKey('h', { altKey: true, ctrlKey: true })) },
		});
	}

	public override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IAccessibleViewService).disableHint();
	}
});
