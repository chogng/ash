import './contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.js';
import '../workbench/contrib/screenshot/electron-browser/screenshot.contribution.js';
import '../workbench/contrib/relauncher/browser/relauncher.contribution.js';
import '../workbench/contrib/splash/electron-browser/splash.contribution.js';
import { ElectronElevatedFileService } from '../workbench/services/files/electron-browser/elevatedFileService.js';
import { IElevatedFileService } from '../workbench/services/files/common/elevatedFileService.js';
import { localize2 } from '../nls.js';
import '../workbench/electron-browser/desktop.contribution.js';
import '../workbench/contrib/browserView/electron-browser/browserView.contribution.js';
import '../workbench/services/browserView/electron-browser/playwrightWorkbenchService.js';
import './contrib/browserView/browser/sessionBrowserView.contribution.js';
import './contrib/chatgptweb/browser/chatGPTWeb.contribution.js';
import './sessions.common.main.js';
import '../workbench/contrib/chat/electron-browser/actions/voiceChatActions.js';
import { AgentsWindowInvitationContribution } from '../workbench/contrib/chat/electron-browser/agentSessions/agentsWindowInvitation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../workbench/common/contributions.js';
import { IInstantiationService } from '../platform/instantiation/common/instantiation.js';
import '../workbench/contrib/terminal/electron-browser/terminal.contribution.js';
import '../workbench/services/clipboard/electron-browser/clipboardService.js';
import '../workbench/services/process/electron-browser/processService.js';
import '../workbench/contrib/processExplorer/electron-browser/processExplorer.contribution.js';
import './browser/parts/menubar.contribution.js';
import './contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js';
import { registerOpenAgentsWindowCommand } from './contrib/openAgentsWindow/electron-browser/openAgentsWindowCommand.js';
import { MenusRegistry } from '../platform/actions/common/actions.js';
import { Menus } from './browser/menus.js';
import { IHostService } from '../workbench/services/host/browser/host.js';
import { NativeHostService } from '../workbench/services/host/electron-browser/nativeHostService.js';
import { ILanguagePackStore } from '../platform/languagePacks/common/languagePackStore.js';
import { BrowserLanguagePackStore } from '../platform/languagePacks/browser/languagePackStore.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IRemoteAuthorityResolverService } from '../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../platform/remote/electron-browser/remoteAuthorityResolverService.js';

registerSingleton(IHostService, NativeHostService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, BrowserLanguagePackStore, InstantiationType.Delayed);
registerSingleton(IRemoteAuthorityResolverService, RemoteAuthorityResolverService, InstantiationType.Delayed);

registerOpenAgentsWindowCommand();
registerWorkbenchContribution(AgentsWindowInvitationContribution.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(AgentsWindowInvitationContribution));

MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: { id: 'workbench.action.closeWindow', title: localize2({ bundle: 'ash', key: 'workbench.closeWindow' }, 'Close Window') },
	group: '6_close',
	order: 5,
});

registerSingleton(IElevatedFileService, ElectronElevatedFileService, InstantiationType.Delayed);
