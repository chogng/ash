import '../workbench/contrib/remote/browser/remote.contribution.js';
import '../workbench/contrib/workspace/browser/workspace.contribution.js';
import '../workbench/contrib/accessibility/browser/accessibility.contribution.js';
import '../workbench/contrib/debug/browser/debug.service.contribution.js';
import '../workbench/services/testing/browser/testingServiceRegistration.js';
import '../workbench/api/browser/extensionHost.contribution.js';
// The shared extension host's SCM bridge requires the Timeline registry in this renderer.
import '../workbench/contrib/timeline/browser/timeline.service.contribution.js';
import '../workbench/contrib/logs/common/logs.contribution.js';
import '../workbench/contrib/debug/browser/debugAdapterManager.js';
import '../workbench/contrib/terminal/terminal.all.js';
import '../workbench/browser/actions/layoutActions.js';
import '../workbench/browser/parts/panel/panelActions.js';
// Register this renderer's Sessions colors before Workbench theme initialization.
import './common/theme.js';
import './common/sessionConfig.js';
import './browser/actions/devContainerActions.js';
// The independent Sessions renderer hosts the same text and diff editors as Code.
import '../editor/editor.all.js';
import '../platform/uriIdentity/common/uriIdentityService.js';
import '../workbench/contrib/commands/common/commands.contribution.js';
import '../workbench/contrib/extensions/browser/extensions.contribution.js';
import '../workbench/contrib/chat/browser/aiCustomization/customizationMarketplace.contribution.js';
import '../workbench/contrib/preferences/browser/preferences.contribution.js';
import '../workbench/contrib/language/browser/languageServers.contribution.js';
import '../workbench/contrib/format/browser/format.contribution.js';
import '../workbench/contrib/inlayHints/browser/inlayHintsAccessibilty.js';
import '../workbench/contrib/limitIndicator/browser/limitIndicator.contribution.js';
import '../workbench/contrib/opener/browser/opener.contribution.js';
import '../workbench/contrib/chat/browser/chat.shared.contribution.js';
import '../workbench/contrib/chat/browser/chat.contribution.js';
import '../workbench/contrib/webview/browser/webview.contribution.js';
import '../workbench/contrib/agentsVoice/browser/agentsVoice.contribution.js';
import './contrib/sessions/browser/views/sessionsViewActions.js';
import '../workbench/contrib/speech/browser/speech.contribution.js';
import '../workbench/contrib/accessibilitySignals/browser/accessibilitySignal.contribution.js';
import '../workbench/services/dialogs/common/dialogService.js';
import '../workbench/services/path/browser/pathService.js';
// Terminal profiles resolve execution-side configuration in either Workbench mode.
import '../workbench/services/configurationResolver/browser/configurationResolverService.js';
import '../workbench/services/dataChannel/browser/dataChannelService.js';
import '../workbench/api/browser/mainThreadDataChannels.contribution.js';
import '../workbench/api/browser/mainThreadUriOpeners.js';
import '../workbench/contrib/github/browser/githubLinkPresentation.contribution.js';
import '../workbench/contrib/github/browser/github.contribution.js';
import '../workbench/contrib/bulkEdit/browser/bulkEditService.js';
import '../workbench/contrib/trace/browser/trace.contribution.js';
import './contrib/files/browser/files.contribution.js';
import './contrib/cowork/browser/cowork.contribution.js';
import './contrib/changes/browser/changes.contribution.js';
import './contrib/trace/browser/trace.contribution.js';
import './browser/turnMultiDiffSource.contribution.js';
import './contrib/editor/browser/emptyFileEditor.contribution.js';
import './contrib/creator/browser/creatorEditor.contribution.js';
import './contrib/creator/browser/creator.contribution.js';
import './contrib/creator/contrib/design/browser/design.contribution.js';
import './contrib/creator/contrib/whiteboard/browser/whiteboard.contribution.js';
import './contrib/creator/contrib/slides/browser/slides.contribution.js';
import './contrib/creator/contrib/brand/browser/brand.contribution.js';
import './contrib/creator/contrib/sites/browser/sites.contribution.js';
import './contrib/creator/contrib/make/browser/make.contribution.js';
import './contrib/creator/contrib/prototype/browser/prototype.contribution.js';
import './contrib/projects/browser/projects.contribution.js';
import './contrib/symphony/browser/symphony.contribution.js';
import './contrib/automations/browser/automations.contribution.js';
import './contrib/sessions/browser/sessions.contribution.js';
import './contrib/layout/browser/sessions.layout.contribution.js';
import '../workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import '../workbench/contrib/snippets/browser/snippets.contribution.js';
import '../workbench/contrib/scm/browser/scm.service.contribution.js';
import '../workbench/contrib/scm/browser/quickDiff.contribution.js';
import './contrib/search/browser/search.contribution.js';
import '../workbench/contrib/mediaPreview/browser/mediaPreview.contribution.js';
import '../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js';
import { registerTerminalView } from '../workbench/contrib/terminal/browser/terminal.contribution.js';
// Connected App tools use the same Task owner and Terminal execution services as Code.
import '../workbench/contrib/tasks/browser/task.contribution.js';
import { registerOutputView } from '../workbench/contrib/output/browser/output.contribution.js';
import { registerCollabViews } from '../workbench/contrib/collab/browser/collab.contribution.js';
import { registerCallView } from '../workbench/contrib/call/browser/call.contribution.js';
import { SessionsViewRegistry } from './common/views.js';
import { Lxicon } from '../base/common/lxicons.js';
import { MenusRegistry } from '../platform/actions/common/actions.js';
import { ICommandService } from '../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../platform/contextkey/common/contextkey.js';
import { localize2 } from '../nls.js';
import { Menus } from './browser/menus.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IWebWorkerService } from '../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../platform/webWorker/browser/webWorkerServiceImpl.js';

// Sessions has its own renderer entry and cannot rely on Code's shared editor service registrations.
registerSingleton(IWebWorkerService, WebWorkerService, InstantiationType.Delayed);

MenusRegistry.appendMenuItem(Menus.ActivityBar, {
	command: { id: 'sessions.newSession', title: localize2({ bundle: 'ash', key: 'sessions.activity.new' }, 'New'), icon: Lxicon.add, toggled: ContextKeyExpr.has('sessions.activity.chatSelected') },
	group: 'navigation', order: 10,
});

MenusRegistry.appendMenuItems([
	{
		id: Menus.CodeActivityBar,
		item: { command: { id: 'sessions.newSession', title: localize2({ bundle: 'ash', key: 'sessions.activity.new' }, 'New'), icon: Lxicon.add, toggled: ContextKeyExpr.has('sessions.activity.codeSelected') }, group: 'navigation', order: 10 },
	},
	{
		id: Menus.CodeActivityBar,
		item: { command: { id: 'sessions.open.collaboration', title: localize2({ bundle: 'ash', key: 'collaboration.title' }, 'Collab'), icon: Lxicon.collab, toggled: ContextKeyExpr.has('sessions.activity.collaborationSelected') }, group: 'navigation', order: 30 },
	},
	{
		id: Menus.CodeActivityBar,
		item: { command: { id: 'sessions.open.teams', title: localize2({ bundle: 'ash', key: 'sessions.activity.teams' }, 'Agent Teams'), icon: Lxicon.agent, toggled: ContextKeyExpr.has('sessions.activity.teamsSelected') }, group: 'navigation', order: 35 },
	},
]);

registerTerminalView(SessionsViewRegistry);
registerOutputView(SessionsViewRegistry);

registerCollabViews(SessionsViewRegistry, accessor => accessor.get(ICommandService).executeCommand('sessions.open.collaboration'));
registerCallView(SessionsViewRegistry);
