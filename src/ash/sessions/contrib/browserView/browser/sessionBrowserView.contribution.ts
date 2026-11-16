import { isHTMLElement } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { SessionBrowserTabsActionViewItem, showSessionBrowserTabs } from './sessionBrowserTabs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionBrowserNetworkContribution } from './sessionBrowserNetwork.js';
import { SessionBrowserViewController } from './sessionBrowserView.js';

// Install policy before browser discovery can open tabs; page restoration still runs after Sessions restoration.
registerWorkbenchContribution(SessionBrowserViewController.ID, WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(SessionBrowserViewController));

registerWorkbenchContribution(SessionBrowserNetworkContribution.ID, WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(SessionBrowserNetworkContribution));

const browserTabsAvailable = new RawContextKey<boolean>('sessions.browserTabsAvailable', false);
const chatBrowserTabs = ContextKeyExpr.and(SessionsWorkspaceModeContext.isEqualTo('chat'), browserTabsAvailable.isEqualTo(true));
const showBrowserTabs = 'sessions.browser.showTabs';

registerAction2(class ShowSessionBrowserTabsAction extends Action2 {
	constructor() {
		super({
			id: showBrowserTabs, title: localize2('sessions.browser.title', 'Browser'), icon: Lxicon.browserExplore,
			precondition: chatBrowserTabs,
			menu: { id: Menus.SessionTitleBar, when: chatBrowserTabs, group: 'navigation', order: 1 },
		});
	}

	override async run(accessor: ServicesAccessor, anchor?: unknown): Promise<void> {
		if (!accessor.get(IContextKeyService).contextMatchesRules(chatBrowserTabs)) return;
		await showSessionBrowserTabs(isHTMLElement(anchor) ? anchor : undefined,
			accessor.get(ISessionsEntryService), accessor.get(IBrowserViewWorkbenchService), accessor.get(IEditorService),
			accessor.get(IEditorPart), accessor.get(IContextViewService), accessor.get(INotificationService));
	}
});

registerWorkbenchContribution('sessions.contrib.browserTabs', WorkbenchPhase.BlockRestore, accessor => {
	const lifetime = new DisposableStore();
	const entries = accessor.get(ISessionsEntryService);
	const available = browserTabsAvailable.bindTo(accessor.get(IContextKeyService));
	lifetime.add(toDisposable(() => available.reset()));
	lifetime.add(autorun(reader => available.set(entries.conversationBrowserContext.read(reader) !== undefined)));
	lifetime.add(accessor.get(IActionViewItemService).register(Menus.SessionTitleBar, showBrowserTabs,
		(action, options) => new SessionBrowserTabsActionViewItem(action, options)));
	return lifetime;
});
