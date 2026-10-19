import { IWebWorkerService } from '../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../platform/webWorker/browser/webWorkerServiceImpl.js';
import { registerSingleton, InstantiationType } from '../platform/instantiation/common/extensions.js';
import './contrib/logs/common/logs.contribution.js';
import './contrib/debug/browser/debugAdapterManager.js';
import '../platform/uriIdentity/common/uriIdentityService.js';
import './contrib/chat/browser/chat.shared.contribution.js';
import './contrib/terminal/terminal.all.js';
import './contrib/memories/browser/memories.contribution.js';
import './contrib/memory/browser/memory.contribution.js';
import './contrib/trace/browser/trace.contribution.js';
import './contrib/issue/browser/issue.contribution.js';
import './contrib/github/browser/githubLinkPresentation.contribution.js';
import './contrib/github/browser/github.contribution.js';
import './services/dialogs/common/dialogService.js';
import './services/path/browser/pathService.js';
import './services/configurationResolver/browser/configurationResolverService.js';
import './services/dataChannel/browser/dataChannelService.js';
import './api/browser/mainThreadDataChannels.contribution.js';
import './api/browser/mainThreadUriOpeners.js';
import './contrib/bulkEdit/browser/bulkEditService.js';
import './contrib/localHistory/browser/localHistory.contribution.js';
/**
 * Shared Workbench registrations loaded by every renderer host.
 *
 * Host-specific services and contributions belong in `workbench.web.main.ts`
 * or `workbench.desktop.main.ts`. Product entries initialize localization
 * before loading this bundle and keep Sessions composition outside Workbench.
 */
import "./browser/workbench.contribution.js";
import './contrib/speech/browser/speech.contribution.js';
import './contrib/accessibilitySignals/browser/accessibilitySignal.contribution.js';
import './browser/actions/layoutActions.js';
import "./contrib/modernUI/browser/modernUI.contribution.js";
import './contrib/mediaPreview/browser/mediaPreview.contribution.js';

import './contrib/extensions/browser/extensions.contribution.js';
import './contrib/chat/browser/aiCustomization/customizationMarketplace.contribution.js';
import './contrib/extensions/browser/extensionRecommendations.contribution.js';
import './contrib/language/browser/languageServers.contribution.js';
import './contrib/localization/common/localization.contribution.js';
import './contrib/commands/common/commands.contribution.js';
import './contrib/authentication/browser/authentication.contribution.js';
import './contrib/onboarding/browser/onboarding.contribution.js';
import './browser/parts/titlebar/commandCenterOnboarding.contribution.js';
import './contrib/update/browser/update.contribution.js';
import './contrib/webview/browser/webview.contribution.js';

import './contrib/output/browser/output.contribution.js';

import './contrib/dropOrPasteInto/browser/dropOrPasteInto.contribution.js';
import './contrib/externalUriOpener/common/externalUriOpener.contribution.js';
import './contrib/url/browser/url.contribution.js';
import './contrib/folding/browser/folding.contribution.js';
import './contrib/snippets/browser/snippets.contribution.js';
import './contrib/scrollLocking/browser/scrollLocking.contribution.js';
import { registerCallView } from './contrib/call/browser/call.contribution.js';
import { registerCollaborationViews } from './contrib/collaboration/browser/collaboration.contribution.js';
import './contrib/agentsVoice/browser/agentsVoice.contribution.js';
import '../editor/editor.code.all.js';
import './contrib/codeEditor/browser/codeEditor.contribution.js';
import './contrib/codeActions/browser/codeActions.contribution.js';
import './contrib/callHierarchy/browser/callHierarchy.contribution.js';
import './contrib/typeHierarchy/browser/typeHierarchy.contribution.js';
import './contrib/documentEditor/browser/documentEditor.contribution.js';
// Task commands, Debug, Testing and the extension host share one task service.
import './contrib/tasks/browser/task.contribution.js';
import './contrib/debug/browser/debug.contribution.js';
import './contrib/testing/browser/testing.contribution.js';
import './api/browser/extensionHost.contribution.js';
import './services/codebaseSymbols/browser/codebaseSymbolsServiceRegistration.js';
import { ISyntaxApi } from '../platform/syntax/common/syntaxApi.js';
import { ILanguageFeaturesService } from '../editor/common/services/languageFeatures.js';
import { registerWorkbenchContribution, WorkbenchPhase } from './common/contributions.js';
import { AppServerSyntaxProviders } from './services/language/browser/appServerSyntaxProviders.js';
import { IRendererHostService } from '../platform/renderer/common/rendererHost.js';
import { Disposable } from '../base/common/lifecycle.js';

registerCollaborationViews();
registerCallView();

registerWorkbenchContribution(
	'code.contrib.appServerSyntax',
	WorkbenchPhase.BlockStartup,
	accessor => accessor.get(IRendererHostService).hasAppServer ? new AppServerSyntaxProviders(
		accessor.get(ILanguageFeaturesService),
		accessor.get(ISyntaxApi),
	) : Disposable.None,
);

registerSingleton(IWebWorkerService, WebWorkerService, InstantiationType.Delayed);
