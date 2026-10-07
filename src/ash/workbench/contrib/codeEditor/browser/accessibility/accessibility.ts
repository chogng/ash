import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';

registerAction2(class ToggleScreenReaderMode extends Action2 {
	constructor() {
		super({
			id: 'editor.action.toggleScreenReaderAccessibilityMode',
			title: localize2('accessibility.toggleScreenReader', 'Toggle Screen Reader Accessibility Mode'),
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('F1', { altKey: true, shiftKey: true })) },
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const accessibility = accessor.get(IAccessibilityService);
		const enabled = !accessibility.isScreenReaderOptimized();
		await accessor.get(IConfigurationService).updateValue('editor.accessibilitySupport', enabled ? 'on' : 'off');
		accessibility.alert(enabled
			? localize('accessibility.screenReaderEnabled', 'Screen reader optimization enabled.')
			: localize('accessibility.screenReaderDisabled', 'Screen reader optimization disabled.'));
	}
});
