import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
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
import type { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import type { IGitHubConnectionService } from '../../../../../services/accounts/common/gitHubConnectionService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
// Match the product host's box sizing so isolated card geometry has the same meaning.
import '../../../../../browser/media/style.css';

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
