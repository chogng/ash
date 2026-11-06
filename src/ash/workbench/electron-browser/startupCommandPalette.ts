import { addDisposableListener } from '../../base/browser/dom.js';
import { ManagedStyleSheet } from '../../base/browser/domStylesheets.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { OpenerService } from '../../editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../editor/standalone/browser/standaloneCodeEditorService.js';
import { IMenuService } from '../../platform/actions/common/actions.js';
import { MenuService } from '../../platform/actions/common/menuService.js';
import { CommandRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextMenuService } from '../../platform/contextview/browser/contextMenuService.js';
import { IContextMenuService, IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../platform/contextview/browser/contextViewService.js';
import type { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../platform/keybinding/common/keybinding.js';
import { getContainerDimension } from '../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { QuickInputController } from '../../platform/quickinput/browser/quickInputController.js';
import type { IQuickPick, IQuickPickItem } from '../../platform/quickinput/common/quickInput.js';
import { QuickAccessRegistry } from '../../platform/quickinput/common/quickAccess.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../platform/theme/common/colorTheme.js';
import { ColorScheme } from '../../platform/theme/common/theme.js';
import { commandActionLabel } from '../../platform/action/common/action.js';
import { OpenFolderAction } from '../browser/actions/workspaceActions.js';
import { ShowAllCommandsCommandId } from '../browser/quickaccess.js';
import { CommandService } from '../services/commands/common/commandService.js';
import { WorkbenchKeybindingService } from '../services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../services/keybinding/browser/keyboardLayoutService.js';
import { NotificationService } from '../services/notification/common/notificationService.js';
import { generateColorThemeCSS } from '../services/themes/browser/colorThemeCss.js';
import { UserDataProfileService } from '../services/userDataProfile/browser/userDataProfileService.js';
import { IUserDataProfileService } from '../services/userDataProfile/common/userDataProfile.js';
import type { ElectronRendererLocalApi } from './rendererApi.js';

const startupThemes = {
	[ColorScheme.Light]: lightColorTheme,
	[ColorScheme.Dark]: darkColorTheme,
	[ColorScheme.HighContrastLight]: highContrastLightColorTheme,
	[ColorScheme.HighContrastDark]: highContrastDarkColorTheme,
};

/** Hosts the regular Quick Pick and keybinding resolver while the Workbench cannot dispatch workspace commands. */
export function createStartupCommandPalette(parent: InstantiationService, ownerWindow: Window, local: ElectronRendererLocalApi, storage: IStorageService, baseTheme: ColorScheme, pickFolder: () => Promise<void>): IDisposable & { readonly query: string | undefined; } {
	const lifetime = new DisposableStore();
	try {
		const { document } = ownerWindow;
		const root = document.createElement('div');
		root.className = 'ash-startup-command-palette';
		// The splash is decorative and remains behind the interactive overlay.
		Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '10001', pointerEvents: 'none' });
		document.body.append(root);
		lifetime.add(toDisposable(() => root.remove()));
		const scope = lifetime.add(parent.createChild(new ServiceCollection(
			[IStorageService, storage],
			[IUserDataProfileService, new UserDataProfileService()],
		)));
		const registry = new CommandRegistry();
		const contexts = lifetime.add(new ContextKeyService());
		const commands = lifetime.add(new CommandService(scope, registry));
		scope.registerInstance(IContextKeyService, contexts);
		scope.registerInstance(ICommandService, commands);
		scope.registerSingleton(ICodeEditorService, () => scope.createInstance(StandaloneCodeEditorService));
		scope.registerSingleton(IOpenerService, () => scope.createInstance(OpenerService));
		scope.registerSingleton(IMenuService, () => scope.createInstance(MenuService));
		scope.registerSingleton(INotificationService, () => scope.createInstance(NotificationService));
		scope.registerSingleton(IContextViewService, () => scope.createInstance(BrowserContextViewService, root));
		scope.registerSingleton(IContextMenuService, () => scope.createInstance(BrowserContextMenuService));
		const keyboard = lifetime.add(new BrowserKeyboardLayoutService({ navigator: ownerWindow.navigator, layoutProvider: local.keyboardLayout, userLayoutProvider: local.userKeyboardLayout }));
		let ready = false;
		const keybindings = lifetime.add(scope.createInstance(WorkbenchKeybindingService, {
			ownerDocument: document, contextKeyService: contexts, commandService: commands, keyboardLayoutService: keyboard,
			canDispatchCommand: (id: string) => ready && registry.hasCommand(id),
		}));
		scope.registerInstance(IKeybindingService, keybindings);
		let picker: IQuickPick<IQuickPickItem> | undefined;
		let controller: QuickInputController | undefined;
		lifetime.add(registry.register(ShowAllCommandsCommandId, () => {
			if (!controller) {
				lifetime.add(new ManagedStyleSheet(document, generateColorThemeCSS(startupThemes[baseTheme], '.ash-startup-command-palette').code));
				controller = lifetime.add(scope.createInstance(QuickInputController, root, undefined, {}));
				const layout = () => controller!.layout(getContainerDimension(root), 0);
				lifetime.add(addDisposableListener(ownerWindow, 'resize', layout));
				layout();
				const input = picker = controller.createQuickPick();
				input.placeholder = QuickAccessRegistry.get('>')!.placeholder;
				input.ariaLabel = input.placeholder;
				input.filterValue = value => value.startsWith('>') ? value.slice(1) : value;
				const action = new OpenFolderAction();
				input.items = [{ label: commandActionLabel(action.desc.title), description: action.desc.id }];
				lifetime.add(input.onDidAccept(() => {
					if (!input.selectedItems.length) return;
					input.hide();
					void pickFolder().catch(onUnexpectedError);
				}));
			}
			picker!.value = '>';
			picker!.show();
		}));
		void keybindings.initialize().catch(onUnexpectedError).then(() => {
			if (lifetime.isDisposed) return;
			ready = true;
			performance.mark('ash.desktop.startup-commands-ready');
		});
		return {
			get query() { return controller?.currentQuickInput === picker && picker ? picker.value : undefined; },
			dispose: () => lifetime.dispose(),
			[Symbol.dispose]: () => lifetime.dispose(),
		};
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
}
