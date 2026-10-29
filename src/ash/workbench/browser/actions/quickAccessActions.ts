import { Keybinding, logicalKey } from '../../../base/common/keybindings.js';
import { localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';

// File navigation uses the same provider as the command center and remains user-bindable.
registerAction2(
	class QuickAccessAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.quickOpen',
				get title() {
					return localize2('workbench.editor.goToFile', 'Go to File');
				},
				f1: true,
				keybinding: { primary: Keybinding.single(logicalKey('p', { primaryKey: true })) },
			});
		}

		override run(accessor: ServicesAccessor): void {
			accessor.get(IQuickInputService).quickAccess.show('');
		}
	},
);
