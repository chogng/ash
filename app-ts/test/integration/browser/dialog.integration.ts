import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/toggle/toggle.css';
import { Dialog } from '../../../src/ash/base/browser/ui/dialog/dialog.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { MenuId, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { CommandRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import type { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import type { IQuickPick, IQuickPickItem } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { CommandsQuickAccessProvider } from '../../../src/ash/workbench/contrib/quickaccess/browser/commandsQuickAccess.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { DialogSeverity, type IDialogOutcome } from '../../../src/ash/platform/dialogs/common/dialogs.js';

declare global {
	interface Window {
		ashDialogIntegration: {
			show(detail: string): void;
			showPrompt(): void;
			showChoice(): void;
			showInput(): void;
			showCheckboxConfirmation(): void;
			showBare(): void;
			disposeBare(): void;
			abort(): void;
			showCommandFailure(): void;
			lastResult?: string;
			lastOutcome?: IDialogOutcome;
		};
	}
}

const handler = new BrowserDialogHandler(document.body);
const commandResources = new DisposableStore();
window.addEventListener('pagehide', () => commandResources.dispose(), { once: true });
let controller: AbortController;
let bareDialog: Dialog;
window.ashDialogIntegration = {
	show(detail: string): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'confirmation',
			title: 'Review changes',
			message: 'Review the details before confirming.',
			detail,
		}, controller.signal).then(result => { window.ashDialogIntegration.lastResult = result.button; });
	},
	showPrompt(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'prompt',
			title: 'Save changes',
			message: 'Choose what to do with the changes.',
			primaryButton: 'Save',
			secondaryButton: 'Discard',
		}, controller.signal).then(result => { window.ashDialogIntegration.lastResult = result.button; });
	},
	showChoice(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'choice', severity: DialogSeverity.Warning, title: 'Choose action', message: 'Select one action.',
			buttons: ['First', 'Second', 'Third'], cancelButton: 'Cancel',
			checkbox: { label: 'Remember choice' },
		}, controller.signal).then(result => { window.ashDialogIntegration.lastOutcome = result; });
	},
	showInput(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'input',
			title: 'Connect',
			message: 'Enter server address',
			inputs: [{ placeholder: 'Server address', value: 'https://' }],
			checkbox: { label: 'Remember server', checked: false },
		}, controller.signal).then(result => { window.ashDialogIntegration.lastOutcome = result; });
	},
	showCheckboxConfirmation(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'confirmation',
			title: 'Remove server',
			message: 'Remove this server?',
			checkbox: { label: 'Also remove credentials' },
		}, controller.signal).then(result => { window.ashDialogIntegration.lastOutcome = result; });
	},
	showBare(): void {
		bareDialog = new Dialog(document.body, { title: 'Plain dialog', content: 'Plain content' });
		void bareDialog.show().then(result => { window.ashDialogIntegration.lastResult = result; });
	},
	disposeBare(): void {
		bareDialog.dispose();
	},
	abort(): void {
		controller.abort();
	},
	showCommandFailure(): void {
		const services = commandResources.add(new InstantiationService());
		const registry = new CommandRegistry();
		commandResources.add(registry.register('test.commandFailure', () => { throw new Error('The command could not finish.'); }));
		commandResources.add(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: { id: 'test.commandFailure', title: 'Failing command' },
		}));
		const commands = commandResources.add(new CommandService(services, registry));
		const contexts = commandResources.add(new ContextKeyService());
		const dialogs = commandResources.add(new DialogService());
		commandResources.add(new DialogHandlerContribution(dialogs.model, handler));
		const keybindings = {
			lookupKeybinding: () => undefined,
			onDidUpdateKeybindings: Event.None,
		} as unknown as IKeybindingService;
		const provider = new CommandsQuickAccessProvider(commands, new MenuService(commands, contexts), keybindings, dialogs);
		const accept = commandResources.add(new Emitter<IQuickPickItem>());
		const picker = {
			items: [] as readonly IQuickPickItem[],
			onDidAccept: accept.event,
			hide() {},
		} as unknown as IQuickPick<IQuickPickItem>;
		commandResources.add(provider.provide(picker));
		const item = picker.items.find(candidate => candidate.label === 'Failing command');
		if (!item) throw new Error('Test command is missing from the Command Palette');
		accept.fire(item);
	},
};
