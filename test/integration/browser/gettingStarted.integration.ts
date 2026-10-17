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
import { RecentWorkspacesService } from '../../../src/ash/workbench/services/workspaces/browser/recentWorkspacesService.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { IWorkspaceOpenService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceOpenService.js';
import { GettingStartedPage } from '../../../src/ash/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import type { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import type { IGitHubConnectionService } from '../../../src/ash/workbench/services/accounts/common/gitHubConnectionService.js';
import { bindTestColorTheme } from './themeFixture.js';

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
const opened: string[] = [];
const workspaceOpen: IWorkspaceOpenService = {
	canOpenFolder: true, canOpenWorkspace: true,
	openFolder: async () => { }, pickFolder: async () => undefined,
	openWorkspace: async root => { opened.push(root); },
};
services.registerInstance(IStorageService, storage);
services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'empty' })));
services.registerInstance(IWorkspaceOpenService, workspaceOpen);
const history = resources.add(services.createInstance(BrowserWorkspacesService));
services.registerInstance(IWorkspacesService, history);
if (params.get('seed') !== 'false') {
	await history.addRecentlyOpened(params.has('workspace')
		? [{ workspace: { id: 'team', configPath: URI.file('/synthetic/Team project #1.code-workspace') }, label: 'Team' }]
		: ['alpha', 'beta'].map(name => ({ folderUri: URI.file(`/synthetic/projects/with-a-long-parent-path/${name}`) })));
}
const recent = resources.add(services.createInstance(RecentWorkspacesService));
await recent.initialize();
const page = resources.add(new GettingStartedPage(
	recent, history, workspaceOpen,
	{ executeCommand: async () => { } } as unknown as ICommandService,
	resources.add(new ContextKeyService()),
	{ connect: async () => { } } as unknown as IGitHubConnectionService,
	theme, storage,
));
page.create(document.querySelector('main')!);
window.ashWelcomeIntegration = {
	get opened() { return opened; },
	addRecent: name => history.addRecentlyOpened([{ folderUri: URI.file(`/synthetic/${name}`) }]),
};
