import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IKeyboardShortcutTroubleshootingService } from '../../../services/keybinding/common/keyboardShortcutTroubleshooting.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { ToggleKeyboardShortcutsTroubleshootingCommandId } from '../common/preferences.js';

const KeyboardShortcutsOutputChannelId = 'keyboard-shortcuts';

registerAction2(class ToggleKeyboardShortcutsTroubleshootingAction extends Action2 {
	constructor() {
		super({
			id: ToggleKeyboardShortcutsTroubleshootingCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.ToggleKeyboardShortcutsTroubleshootingAction' }, 'Developer: Toggle Keyboard Shortcuts Troubleshooting'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const enabled = accessor.get(IKeyboardShortcutTroubleshootingService).toggle();
		if (enabled) {
			accessor.get(IOutputService).showChannel(KeyboardShortcutsOutputChannelId, {
				focus: 'preserve',
			});
		}
	}
});

registerWorkbenchContribution(
	'workbench.contrib.keyboardShortcutTroubleshooting',
	WorkbenchPhase.BlockRestore,
	(accessor) => {
		const disposables = new DisposableStore();
		const troubleshooting = accessor.get(IKeyboardShortcutTroubleshootingService);
		const channel = disposables.add(accessor.get(IOutputService).createChannel({
			id: KeyboardShortcutsOutputChannelId,
			label: localize({ bundle: 'ash.workbench', key: 'keyboardLayout.shortcutsChannel' }, 'Keyboard Shortcuts'),
			kind: 'log',
			source: 'core',
		}));
		disposables.add(troubleshooting.onDidLog((message) => {
			channel.appendLine({
				severity: 'debug',
				category: 'keybinding',
				text: message,
			});
		}));
		return disposables;
	},
);
