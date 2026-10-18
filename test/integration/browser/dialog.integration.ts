import { Dialog } from '../../../src/ash/base/browser/ui/dialog/dialog.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { isCancellationError } from '../../../src/ash/base/common/errors.js';
import type { ISandboxGlobals } from '../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import type { IWorkspaceTrustApi } from '../../../src/ash/platform/workspace/common/workspaceTrust.js';
import type { DirectoryPermissionDialog } from '../../../src/ash/workbench/electron-browser/parts/dialogs/directoryPermissionDialog.js';
import { MenuId, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { CommandRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import type { IQuickPick, IQuickPickItem, IQuickPickDidAcceptEvent } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { CommandsQuickAccessProvider } from '../../../src/ash/workbench/contrib/quickaccess/browser/commandsQuickAccess.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { DialogSeverity, IDialogService, type IDialogOutcome } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { StandaloneCodeEditorService } from '../../../src/ash/editor/standalone/browser/standaloneCodeEditorService.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';

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
			showDirectoryPermission(): Promise<void>;
			cancelDirectoryPermission(): void;
			holdDirectoryPrompt(): void;
			releaseDirectoryPrompt(): void;
			lastDirectoryResult?: string;
			directoryWrites: number;
			lastResult?: string;
			lastOutcome?: IDialogOutcome;
		};
	}
}

const handler = new BrowserDialogHandler(document.body);
const commandResources = new DisposableStore();
const directoryFlow = commandResources.add(new MutableDisposable<DisposableStore>());
const directoryPrompt = {
	kind: 'prompt', title: 'Directory permissions', message: 'Authorize this workspace directory.', detail: '/srv/project',
	primaryButton: 'Read only', secondaryButton: 'Development', cancelButton: 'Cancel',
};
let heldDirectoryPrompt: DeferredPromise<unknown> | undefined;
let holdNextDirectoryPrompt = false;
Object.defineProperty(globalThis, 'ash', {
	configurable: true, value: {
		ipcRenderer: {
			send() { },
			on: () => ({ dispose() { } }),
			invoke: async channel => {
				if (channel !== 'ash:host:directoryPermissionPrompt') throw new Error(`Unexpected fixture IPC channel: ${channel}`);
				if (holdNextDirectoryPrompt) { holdNextDirectoryPrompt = false; return heldDirectoryPrompt!.p; }
				return directoryPrompt;
			},
		},
		ipcMessagePort: { acquire: () => ({ dispose() { } }) },
		process: { platform: 'linux', arch: 'x64' },
		webUtils: { getPathForFile: () => '' },
	} satisfies ISandboxGlobals
});
let directoryPermission: DirectoryPermissionDialog | undefined;
let cancelDirectoryPermission = (): void => { };
window.addEventListener('pagehide', () => commandResources.dispose(), { once: true });
let controller: AbortController;
let bareDialog: Dialog;
window.ashDialogIntegration = {
	directoryWrites: 0,
	async showDirectoryPermission(): Promise<void> {
		const [{ DirectoryPermissionDialog }, { initializeWorkspaceDirectories }] = await Promise.all([
			import('../../../src/ash/workbench/electron-browser/parts/dialogs/directoryPermissionDialog.js'),
			import('../../../src/ash/platform/workspaces/electron-browser/appServerWorkspaceHost.js'),
		]);
		directoryPermission ??= commandResources.add(new DirectoryPermissionDialog(document.body));
		const resources = directoryFlow.value = new DisposableStore();
		const changes = resources.add(new Emitter<'ready' | 'stopped'>());
		const client = {
			state: 'ready' as 'ready' | 'stopped', generation: 1, onStateChange: changes.event,
			request: async () => { window.ashDialogIntegration.directoryWrites++; return { dirs: [] }; },
		};
		cancelDirectoryPermission = () => { client.state = 'stopped'; changes.fire('stopped'); };
		const unexpected = async (): Promise<never> => { throw new Error('Unexpected directory management request'); };
		const trust: IWorkspaceTrustApi = {
			onDidChangeTrust: Event.None,
			listDirectories: unexpected, setDirectoryPermissions: unexpected, forgetDirectory: unexpected,
			readWorkspaceDirectory: unexpected, persistGrant: unexpected,
			readDirectory: async path => ({ dir: path, permissions: undefined }),
			createGrant: async (_path, permissions) => ({ type: 'user', commandId: 'directory-prompt', expectedRevision: 1, permissions }),
		};
		window.ashDialogIntegration.lastDirectoryResult = undefined;
		void initializeWorkspaceDirectories(client as unknown as AppServerProtocolClient, directoryPermission, trust, [{ id: 'directory-root', path: '/srv/project' }])
			.then(() => { window.ashDialogIntegration.lastDirectoryResult = 'ready'; }, error => {
				window.ashDialogIntegration.lastDirectoryResult = isCancellationError(error) ? 'cancelled' : String(error);
			});
	},
	cancelDirectoryPermission(): void { cancelDirectoryPermission(); },
	holdDirectoryPrompt(): void { heldDirectoryPrompt = new DeferredPromise<unknown>(); holdNextDirectoryPrompt = true; },
	releaseDirectoryPrompt(): void { const pending = heldDirectoryPrompt; heldDirectoryPrompt = undefined; void pending?.complete(directoryPrompt); },
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
		const editors = commandResources.add(services.createInstance(StandaloneCodeEditorService));
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IMenuService, new MenuService(commands, contexts));
		services.registerInstance(IKeybindingService, keybindings);
		services.registerInstance(IDialogService, dialogs);
		services.registerInstance(ICodeEditorService, editors);
		services.registerInstance(IConfigurationService, commandResources.add(new InMemoryConfigurationService()));
		services.registerInstance(IStorageService, commandResources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'dialog', flushInterval: 0 })));
		services.registerInstance(IQuickInputService, commandResources.add(new TestQuickInputService({ container: document.body, instantiationService: services })));
		services.registerInstance(IPreferencesService, {
			openSettings: async () => { throw new Error('Unexpected settings request'); },
			openUserSettings: async () => { throw new Error('Unexpected user settings request'); },
			openGlobalKeybindingSettings: async () => { throw new Error('Unexpected keybindings request'); },
		});
		const provider = commandResources.add(services.createInstance(CommandsQuickAccessProvider));
		const accept = commandResources.add(new Emitter<IQuickPickDidAcceptEvent>());
		const picker = {
			selectedItems: [], value: '', filterValue: (value: string) => value, onDidChangeValue: Event.None, onDidTriggerItemButton: Event.None,
			items: [] as readonly IQuickPickItem[],
			onDidAccept: accept.event,
			hide() { },
		} as unknown as IQuickPick<IQuickPickItem>;
		commandResources.add(provider.provide(picker));
		const item = picker.items.find(candidate => candidate.label === 'Failing command');
		if (!item || 'type' in item) throw new Error('Test command is missing from the Command Palette');
		picker.selectedItems = [item];
		accept.fire({ inBackground: false });
	},
};
