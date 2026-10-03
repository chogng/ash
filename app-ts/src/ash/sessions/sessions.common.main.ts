import '../workbench/contrib/skills/browser/skills.contribution.js';
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
import { SessionsPageRegistry } from './browser/pages.js';

SessionsPageRegistry.registerPage({
	id: 'chat', title: 'Chat', titleKey: 'sessions.activity.chat', icon: Lxicon.chat2, activeIcon: Lxicon.chat2Filled, order: 10,
	layout: { conversation: 'chat', sidebar: 'sessions', primary: 'sessions', editor: 'hidden', auxiliaryBar: 'hidden', panel: false },
});
SessionsPageRegistry.registerPage({
	id: 'colab', title: 'Collaboration', titleKey: 'sessions.activity.colab', icon: Lxicon.colab, activeIcon: Lxicon.colabFilled, order: 20,
	layout: { sidebar: 'hidden', primary: 'sessions', editor: 'hidden', auxiliaryBar: 'hidden', panel: false },
});
SessionsPageRegistry.registerPage({
	id: 'code', title: 'Code', titleKey: 'sessions.mode.code', icon: Lxicon.code, order: 40,
	layout: { conversation: 'code', sidebar: 'sessions', primary: 'sessions', editor: 'session', auxiliaryBar: 'session', panel: true },
});

registerTerminalView(SessionsViewRegistry);
