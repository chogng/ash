import { getKeybindingLabel } from '../../../../../base/common/keybindingLabels.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { OpenKeyboardShortcutsCommandId, OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import { localize } from '../../../../../nls.js';

export const SELECT_MICROPHONE_COMMAND = 'workbench.action.chat.selectSpeechToTextMicrophone';

export function getDictationContextMenuActions(commandService: ICommandService, configurationService: IConfigurationService, keybindingService: IKeybindingService, keybindingCommandId: string): IAction[] {
	const action = (id: string, label: string, run: () => unknown, checked?: boolean): IAction => ({ id, label, tooltip: label, enabled: true, checked, run });
	const binding = keybindingService.lookupKeybinding(keybindingCommandId);
	const shortcut = binding ? getKeybindingLabel(binding) : undefined;
	return [
		action('dictation.configureShortcut', localize('dictation.configureShortcut', 'Configure shortcut{0}', shortcut ? ` (${shortcut})` : ''), () => commandService.executeCommand(OpenKeyboardShortcutsCommandId)),
		action('dictation.toggleButton', localize('dictation.showButton.title', 'Show microphone button'), () => configurationService.updateValue('dictation.showButton', configurationService.getValue('dictation.showButton') === false), configurationService.getValue('dictation.showButton') !== false),
		action('dictation.disable', localize('dictation.disable', 'Disable dictation'), async () => { await commandService.executeCommand('workbench.action.chat.cancelSpeechToText'); await configurationService.updateValue('dictation.enabled', false); }),
		new Separator(),
		action(SELECT_MICROPHONE_COMMAND, localize('dictation.selectMicrophone', 'Select microphone'), () => commandService.executeCommand(SELECT_MICROPHONE_COMMAND)),
		action('dictation.openSettings', localize('dictation.openSettings', 'Dictation settings'), () => commandService.executeCommand(OpenSettingsCommandId, { section: 'dictation' })),
	];
}

export function addMicButtonContextMenuListener(container: HTMLElement, getActions: () => IAction[], contextMenuService: IContextMenuService): IDisposable {
	return addDisposableListener(container, 'contextmenu', event => {
		event.preventDefault(); event.stopPropagation();
		contextMenuService.showContextMenu({ getAnchor: () => ({ x: event.clientX, y: event.clientY, targetWindow: container.ownerDocument.defaultView! }), getActions });
	});
}
