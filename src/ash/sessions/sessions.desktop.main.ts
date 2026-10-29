import './contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.js';
import '../workbench/services/imageEditor/electron-browser/nativeImageEditorService.js';
import '../workbench/contrib/relauncher/browser/relauncher.contribution.js';
import '../workbench/contrib/splash/electron-browser/splash.contribution.js';
import { ElectronElevatedFileService } from '../workbench/services/files/electron-browser/elevatedFileService.js';
import { IElevatedFileService } from '../workbench/services/files/common/elevatedFileService.js';
import { localize2 } from '../nls.js';
import { ReloadWindowAction } from '../workbench/browser/actions/windowActions.js';
import '../workbench/electron-browser/desktop.contribution.js';
import '../workbench/contrib/browserView/electron-browser/browserView.contribution.js';
import '../workbench/services/browserView/electron-browser/playwrightWorkbenchService.js';
import './contrib/browserView/browser/sessionBrowserView.contribution.js';
import './contrib/chatgptweb/browser/chatGPTWeb.contribution.js';
import './sessions.common.main.js';
import '../platform/update/common/update.config.contribution.js';
import '../workbench/services/update/electron-browser/updateService.js';
import '../workbench/contrib/update/electron-browser/update.contribution.js';
import '../workbench/contrib/chat/electron-browser/actions/voiceChatActions.js';
import { AgentsWindowInvitationContribution } from '../workbench/contrib/chat/electron-browser/agentSessions/agentsWindowInvitation.js';
import { ChatScreenshotContribution } from '../workbench/contrib/chat/electron-browser/chatScreenshot.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../workbench/common/contributions.js';
import { IInstantiationService } from '../platform/instantiation/common/instantiation.js';
registerWorkbenchContribution('workbench.contrib.chatScreenshot', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(ChatScreenshotContribution));
import '../workbench/contrib/terminal/electron-browser/terminal.contribution.js';
import '../workbench/services/clipboard/electron-browser/clipboardService.js';
import '../workbench/services/menubar/electron-browser/menubarService.js';
import '../workbench/services/process/electron-browser/processService.js';
import '../workbench/contrib/processExplorer/electron-browser/processExplorer.contribution.js';
import './browser/parts/menubar.contribution.js';
import './contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js';
import { registerOpenAgentsWindowCommand } from './contrib/openAgentsWindow/electron-browser/openAgentsWindowCommand.js';
import { OpenAshWindowAction } from './electron-browser/actions/ashActions.js';
import { MenusRegistry, registerAction2 } from '../platform/actions/common/actions.js';
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
registerAction2(OpenAshWindowAction);
registerAction2(ReloadWindowAction);
registerWorkbenchContribution(AgentsWindowInvitationContribution.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(AgentsWindowInvitationContribution));

MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: { id: 'workbench.action.closeWindow', title: localize2({ bundle: 'ash', key: 'workbench.closeWindow' }, 'Close Window') },
	group: '6_close',
	order: 5,
});

registerSingleton(IElevatedFileService, ElectronElevatedFileService, InstantiationType.Delayed);
