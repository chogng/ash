import { MenuId, type IMenuItem } from '../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export const Menus = {
	ActivityBar: new MenuId('SessionsActivityBar'),
	ActivityBarContext: new MenuId('SessionsActivityBarContext'),
	SessionActivityBar: new MenuId('SessionActivityBar'),
	SessionActivityBarContext: new MenuId('SessionActivityBarContext'),
	CustomViewAutomations: new MenuId('CustomViewAutomations'),
	CustomViewScheduled: new MenuId('CustomViewScheduled'),
	CustomViewCanvas: new MenuId('CustomViewCanvas'),
	SidebarChatSessionContext: new MenuId('SidebarChatSessionContext'),
	SidebarCodeSessionContext: new MenuId('SidebarCodeSessionContext'),
	SidebarChatProjectContext: new MenuId('SidebarChatProjectContext'),
	SidebarCodeProjectContext: new MenuId('SidebarCodeProjectContext'),
	SidebarSessionsHeader: new MenuId('SidebarSessionsHeader'),
	SessionsViewFilter: new MenuId('SessionsViewPaneFilterSubMenu'),
	NewSessionChatInputToolbar: new MenuId('NewSessionChatInputToolbar'),
	ArtifactCanvasToolbar: new MenuId('ArtifactCanvasToolbar'),
	MenubarMainMenu: new MenuId('SessionsMenubarMainMenu'),
	MenubarFileMenu: new MenuId('SessionsMenubarFileMenu'),
	TitleBarLeftLayout: new MenuId('SessionsTitleBarLeftLayout'),
	TitleBarPageContent: new MenuId('SessionsTitleBarPageContent'),
	TitleBarRightLayout: new MenuId('SessionsTitleBarRightLayout'),
	CodeAddTab: new MenuId('SessionsAddTab'),
	SessionsEditorHeaderPrimary: new MenuId('SessionsEditorHeaderPrimary'),
	SessionsEditorHeaderLayout: new MenuId('SessionsEditorHeaderLayout'),
	SessionsTerminalSplit: new MenuId('SessionsTerminalSplit'),
	SessionsEditorTitle: new MenuId('SessionsEditorTitle'),
	SessionsEditorTabsBarAddTabCanvas: new MenuId('SessionsEditorTabsBarAddTabCanvas'),
} as const;

export const SessionActivityBarVisibleContext = new RawContextKey<boolean>('sessions.sessionActivityBarVisible', false);
export const SessionsFlatLayoutContext = new RawContextKey<boolean>('sessions.flatLayout', false);

/** Both menu placements share the tool's command and its availability rules. */
export function sessionToolMenuItems(item: IMenuItem): { id: MenuId; item: IMenuItem; }[] {
	return [
		{
			id: Menus.TitleBarRightLayout,
			item: { ...item, when: ContextKeyExpr.and(item.when, ContextKeyExpr.not(SessionActivityBarVisibleContext.key)) },
		},
		{
			id: Menus.SessionActivityBar,
			item: { ...item, when: ContextKeyExpr.and(item.when, SessionActivityBarVisibleContext.isEqualTo(true)) },
		},
	];
}
