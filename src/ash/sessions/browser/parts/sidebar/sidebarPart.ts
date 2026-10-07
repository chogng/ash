import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/sidebarPart.css";
import { h } from '../../../../base/browser/dom.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import { ISessionsManagementService } from "../../../services/sessions/common/sessionsManagement.js";
import { ISessionsService } from "../../../services/sessions/browser/sessionsService.js";
import { SidebarPart as WorkbenchSidebarPart } from '../../../../workbench/browser/parts/sidebar/sidebarPart.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { SessionsList } from "./sessionsList.js";
import { TeamsPanel, type TeamRoleOption } from './teamsPanel.js';
import { ITeamsManagementService } from '../../../services/teams/common/teamsManagement.js';
import { SESSION_SIDEBAR_DEFAULT_WIDTH } from '../../../common/layoutConstants.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IGitHubService } from '../../../contrib/github/browser/githubService.js';

export const SESSIONS_NAVIGATION_CONTAINER_ID = 'sessions.navigation.chats';
export const TEAMS_NAVIGATION_CONTAINER_ID = 'sessions.navigation.teams';

export function registerSessionsNavigation(listRoles: () => Promise<readonly TeamRoleOption[]>): IDisposable {
	const registrations = new DisposableStore();
	for (const [id, title, key, ctorDescriptor] of [
		[SESSIONS_NAVIGATION_CONTAINER_ID, 'Chat', 'sessions.activity.chat', new SyncDescriptor(SessionsNavigationView)],
		[TEAMS_NAVIGATION_CONTAINER_ID, 'Collaboration', 'sessions.activity.colab', new SyncDescriptor(TeamsNavigationView, [listRoles])],
	] as const) {
		registrations.add(SessionsViewRegistry.registerViewContainer({ id, title, localizationKey: { bundle: 'ash', key }, location: ViewContainerLocation.Sidebar, order: 0 }));
		registrations.add(SessionsViewRegistry.registerViews(id, [{ id: id + '.view', title, localizationKey: { bundle: 'ash', key }, ctorDescriptor, canToggleVisibility: false }]));
	}
	return registrations;
}

class SessionsNavigationView extends ViewPane {
	private readonly list: SessionsList;
	constructor(parent: HTMLElement, options: IViewPaneOptions, @ISessionsManagementService management: ISessionsManagementService, @ISessionsService sessions: ISessionsService, @IGitHubService github: IGitHubService, @ISessionGroupsService groups: ISessionGroupsService) {
		super(parent, options);
		this.contentElement.classList.add('ash-sessions-navigation-view');
		this.list = this._register(new SessionsList(this.contentElement, management, sessions, localize('sessions.activity.chat', 'Chat'), localize('chat.sessions.new', 'New Session'), github, groups));
	}
	public focus(): void { this.list.focus(); }
}

class TeamsNavigationView extends ViewPane {
	private readonly teams: TeamsPanel;
	constructor(listRoles: () => Promise<readonly TeamRoleOption[]>, parent: HTMLElement, options: IViewPaneOptions, @ITeamsManagementService teams: ITeamsManagementService, @ISessionsService sessions: ISessionsService, @IQuickInputService quickInput: IQuickInputService) {
		super(parent, options);
		this.contentElement.classList.add('ash-sessions-navigation-view');
		this.teams = this._register(new TeamsPanel(this.contentElement, teams, sessions, quickInput, listRoles));
		this.teams.domNode.hidden = false;
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) { void this.teams.show(); }
	}
	public focus(): void { this.teams.focus(); }
}

/** Shared container host with Sessions Activity Bar placement and sizing. */
export class SidebarPart extends WorkbenchSidebarPart {
	private readonly topActivityBarHost: HTMLDivElement;
	private readonly bottomActivityBarHost: HTMLDivElement;
	override get minimumWidth(): number { return 240; }
	override get maximumWidth(): number { return 520; }
	override get preferredWidth(): number {
		const width = this.activeCompositeId ? this.getComposite(this.activeCompositeId)!.getOptimalWidth() : 0;
		return Math.max(SESSION_SIDEBAR_DEFAULT_WIDTH, width);
	}
	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
	) {
		super(container, {
			viewDescriptorService: descriptors, contextKeyService: contextKeys, compositeBarVisible: false,
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
		}, themeService, storage);
		this.topActivityBarHost = h(container.ownerDocument, 'div');
		this.topActivityBarHost.className = 'ash-sessions-activity-host top';
		this.topActivityBarHost.hidden = true;
		this.domNode.insertBefore(this.topActivityBarHost, this.titleDomNode);
		this.bottomActivityBarHost = h(container.ownerDocument, 'div');
		this.bottomActivityBarHost.className = 'ash-sessions-activity-host bottom';
		this.bottomActivityBarHost.hidden = true;
		this.contentDomNode.append(this.bottomActivityBarHost);
	}
	public override getPaneCompositeOptions(): ReturnType<WorkbenchSidebarPart['getPaneCompositeOptions']> {
		return { paneLayout: 'fill', mergeViewWithContainerWhenSingleView: true };
	}
	public override showComposite(id: string, focus = false): void {
		super.showComposite(id, focus);
		this.contentDomNode.insertBefore(this.getComposite(id)!.element, this.bottomActivityBarHost);
	}
	override setActivityBarLocation(location: ActivityBarPosition): HTMLElement | undefined {
		this.topActivityBarHost.hidden = location !== ActivityBarPosition.TOP;
		this.bottomActivityBarHost.hidden = location !== ActivityBarPosition.BOTTOM;
		if (location === ActivityBarPosition.TOP) { return this.topActivityBarHost; }
		if (location === ActivityBarPosition.BOTTOM) { return this.bottomActivityBarHost; }
		return undefined;
	}
}
