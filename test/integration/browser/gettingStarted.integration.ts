import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../src/ash/platform/workspaces/common/workspaces.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { BrowserWorkspacesService } from '../../../src/ash/workbench/services/workspaces/browser/workspacesService.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { TestHostService } from '../../../src/ash/workbench/services/host/test/browser/testHostService.js';
import type { IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { GettingStartedPage } from '../../../src/ash/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import type { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import type { IGitHubConnectionService } from '../../../src/ash/workbench/services/accounts/common/gitHubConnectionService.js';
import { bindTestColorTheme } from './themeFixture.js';
// Match the product host's box sizing so isolated card geometry has the same meaning.
import '../../../src/ash/workbench/browser/media/style.css';

declare global {
	interface Window { ashWelcomeIntegration: { readonly opened: readonly string[]; addRecent(name: string): Promise<void>; }; }
}

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const params = new URLSearchParams(location.search);
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
	{ executeCommand: async () => { } } as unknown as ICommandService,
	contexts,
	{ connect: async () => { } } as unknown as IGitHubConnectionService,
	theme, storage,
));
page.create(document.querySelector('main')!);
window.ashWelcomeIntegration = {
	get opened() { return host.opened.flatMap(request => request.targets.map(target => ('workspaceUri' in target ? target.workspaceUri : target.folderUri).fsPath)); },
	addRecent: name => history.addRecentlyOpened([{ folderUri: URI.file(`/synthetic/${name}`) }]),
};
