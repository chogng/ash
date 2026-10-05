import '../workbench/contrib/skills/browser/skills.contribution.js';
import '../workbench/services/dialogs/common/dialogService.js';
import '../workbench/services/dataChannel/browser/dataChannelService.js';
import '../workbench/api/browser/mainThreadDataChannels.contribution.js';
import '../workbench/api/browser/mainThreadUriOpeners.js';
import '../workbench/contrib/github/browser/githubLinkPresentation.contribution.js';
import '../workbench/contrib/bulkEdit/browser/bulkEditService.js';
import '../workbench/contrib/chat/browser/chatEditing/chatEditing.contribution.js';
import './contrib/files/browser/files.contribution.js';
import './contrib/changes/browser/changes.contribution.js';
import './contrib/editor/browser/emptyFileEditor.contribution.js';
import './contrib/design/browser/design.contribution.js';
import './contrib/library/browser/library.contribution.js';
import '../workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import '../workbench/contrib/mediaPreview/browser/mediaPreview.contribution.js';
import '../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js';
import { registerTerminalView } from '../workbench/contrib/terminal/browser/terminal.contribution.js';
import { SessionsViewRegistry } from './common/views.js';
import { Lxicon } from '../base/common/lxicons.js';
import { MenusRegistry } from '../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../platform/contextkey/common/contextkey.js';
import { localize2 } from '../nls.js';
import { Menus } from './browser/menus.js';

for (const [id, title, icon, activeIcon, order] of [
	['chat', localize2({ bundle: 'ash', key: 'sessions.activity.chat' }, 'Chat'), Lxicon.chat2, Lxicon.chat2Filled, 10],
	['teams', localize2({ bundle: 'ash', key: 'sessions.activity.colab' }, 'Collaboration'), Lxicon.colab, Lxicon.colabFilled, 20],
	['code', localize2({ bundle: 'ash', key: 'sessions.mode.code' }, 'Code'), Lxicon.code, Lxicon.code, 40],
] as const) {
	MenusRegistry.appendMenuItem(Menus.ActivityBar, {
		command: { id: `sessions.open.${id}`, title, icon, toggled: { condition: ContextKeyExpr.has(`sessions.activity.${id}Selected`), icon: activeIcon } },
		group: 'navigation', order,
	});
}

registerTerminalView(SessionsViewRegistry);
