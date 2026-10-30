import { agentsWindowGraphicConfiguration, type AgentsWindowGraphicVariant } from '../../../../chat/common/constants.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../../../../platform/workspaces/common/workspaces.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { BrowserWorkspacesService } from '../../../../../services/workspaces/browser/workspacesService.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { TestHostService } from '../../../../../services/host/test/browser/testHostService.js';
import type { IFileDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { GettingStartedPage } from '../../../browser/gettingStarted.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../chat/common/constants.js';
import { setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import type { IGitHubConnectionService } from '../../../../../services/accounts/common/gitHubConnectionService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
// Match the product host's box sizing so isolated card geometry has the same meaning.
import '../../../../../browser/media/style.css';

declare global {
	interface Window { ashWelcomeIntegration: { readonly opened: readonly string[]; readonly editorLaunches: number; readonly agentsLaunches: number; setAgentsAvailable(available: boolean): void; setEditorWindows(count: number): void; setGraphic(value: string): Promise<void>; addRecent(name: string): Promise<void>; }; }
}

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const params = new URLSearchParams(location.search);
if (params.get('locale') === 'zh-CN') {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	document.documentElement.lang = chinese.locale;
}
let agentsLaunches = 0;
const agentsCommand = resources.add(new MutableDisposable());
const setAgentsAvailable = (available: boolean): void => {
	agentsCommand.clear();
	if (available) agentsCommand.value = CommandsRegistry.register(OPEN_AGENTS_WINDOW_COMMAND_ID, () => { agentsLaunches++; });
};
setAgentsAvailable(params.has('agents'));
const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
if (!registry.owns(agentsWindowGraphicConfiguration.key)) registry.registerConfiguration(agentsWindowGraphicConfiguration);
const configuration = resources.add(new InMemoryConfigurationService());
if (params.has('graphic')) await configuration.updateValue(agentsWindowGraphicConfiguration.key, params.get('graphic'));

const theme = resources.add(new TestThemeService(themes[params.get('theme') as keyof typeof themes] ?? lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'welcome-test', flushInterval: 0 }));
const services = resources.add(new InstantiationService());
const host = new TestHostService();
services.registerInstance(IStorageService, storage);
services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'empty' })));
const history = resources.add(services.createInstance(BrowserWorkspacesService));
services.registerInstance(IWorkspacesService, history);
if (params.get('seed') !== 'false') {
	await history.addRecentlyOpened(params.has('workspace')
		? [{ workspace: { id: 'team', configPath: URI.file('/synthetic/Team project #1.code-workspace') }, label: 'Team' }]
		: ['alpha', 'beta'].map(name => ({ folderUri: URI.file(`/synthetic/projects/with-a-long-parent-path/${name}`) })));
}
const contexts = resources.add(new ContextKeyService());
contexts.setContext('openFolderWorkspaceSupport', true);
const page = resources.add(new GettingStartedPage(
	history, host, {} as IFileDialogService,
	resources.add(new CommandService(services)),
	contexts,
	{ connect: async () => { } } as unknown as IGitHubConnectionService,
	configuration, theme, storage,
));
page.create(document.querySelector('main')!);
window.ashWelcomeIntegration = {
	get agentsLaunches() { return agentsLaunches; },
	get editorLaunches() { return host.opened.filter(request => request.targets.length === 0).length; },
	setAgentsAvailable,
	setGraphic: value => configuration.updateValue(agentsWindowGraphicConfiguration.key, value as AgentsWindowGraphicVariant),
	setEditorWindows: count => {
		host.windows = [
			...Array.from({ length: count }, (_, index) => ({ id: index + 1, title: 'Editor', focused: index === 0, current: index === 0, kind: 'editor' as const })),
			{ id: 99, title: 'Agents', focused: false, current: false, kind: 'managed' },
			{ id: 100, title: 'Detached editor', focused: false, current: false, kind: 'auxiliary' },
		];
		page.setVisible(true);
	},
	get opened() { return host.opened.flatMap(request => request.targets.map(target => ('workspaceUri' in target ? target.workspaceUri : target.folderUri).fsPath)); },
	addRecent: name => history.addRecentlyOpened([{ folderUri: URI.file(`/synthetic/${name}`) }]),
};
