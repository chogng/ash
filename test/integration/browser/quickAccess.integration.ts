import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { Action2, IMenuService, registerAction2 } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { QuickAccessController } from '../../../src/ash/platform/quickinput/browser/quickAccess.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IEditorPartsService } from '../../../src/ash/workbench/browser/parts/editor/editorParts.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { CodeEditorService } from '../../../src/ash/workbench/services/editor/browser/codeEditorService.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { WorkbenchQuickInputService } from '../../../src/ash/workbench/services/quickinput/browser/quickInputService.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';

declare global {
	interface Window {
		ashQuickAccessIntegration: { setHistoryLength(value: number): Promise<void>; };
	}
}

const parameters = new URLSearchParams(location.search);
if (parameters.get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, values) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, values));
}
await import('../../../src/ash/workbench/contrib/quickaccess/browser/quickAccess.contribution.js');
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'quick-access', flushInterval: 0 })));
services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
services.registerInstance(IDialogService, resources.add(new DialogService()));
services.registerInstance(IKeybindingService, { lookupKeybinding: () => undefined, onDidUpdateKeybindings: Event.None } as unknown as IKeybindingService);
const contexts = resources.add(new ContextKeyService());
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(IMenuService, new MenuService(commands, contexts));
const quickInput = resources.add(new WorkbenchQuickInputService({ container: document.body, contextKeyService: contexts }));
services.registerInstance(IQuickInputService, quickInput);
const quickAccess = resources.add(services.createInstance(QuickAccessController));
const theme = parameters.get('theme') === 'hc' ? highContrastDarkColorTheme : parameters.get('theme') === 'dark' ? darkColorTheme : lightColorTheme;
resources.add(bindColorTheme(resources.add(new TestThemeService(theme)), document.body));
const executions: string[] = [];
for (const label of ['Alpha Format', 'Zulu Format', 'Format']) {
	resources.add(registerAction2(class extends Action2 {
		constructor() { super({ id: `test.quickAccess.${label.replaceAll(' ', '')}`, title: label, f1: true }); }
		public override run(): void {
			executions.push(label);
			document.querySelector('output')!.textContent = executions.join(', ');
		}
	}));
}
resources.add(addDisposableListener(document.querySelector('#open')!, 'click', () => quickAccess.show('>')));
window.ashQuickAccessIntegration = { setHistoryLength: value => configuration.updateValue('workbench.commandPalette.history', value) };
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
