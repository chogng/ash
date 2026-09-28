import "./media/sidebarPart.css";
import { addDisposableListener, h } from '../../../base/browser/dom.js';
import { localize } from '../../../nls.js';
import type { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { ActivityBarPosition } from '../../../workbench/common/configuration.js';
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import { SessionsList } from "./sessionsList.js";
import { TeamsPanel, type TeamRoleOption } from './teamsPanel.js';
import type { ITeamsManagementService } from '../../services/teams/common/teamsManagement.js';

/** Session navigation Part for the dedicated Sessions Workbench. */
export class SidebarPart extends WorkbenchPart {
	private readonly list: SessionsList;
	private readonly teams: TeamsPanel;
	private readonly chatTab: HTMLButtonElement;
	private readonly teamsTab: HTMLButtonElement;
	private activeTab: 'chats' | 'teams' = 'chats';
	private readonly topActivityBarHost: HTMLDivElement;
	private readonly bottomActivityBarHost: HTMLDivElement;

	override get minimumWidth(): number { return 240; }
	override get maximumWidth(): number { return 520; }

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService, teamsService: ITeamsManagementService, quickInput: IQuickInputService, listRoles: () => Promise<readonly TeamRoleOption[]>) {
		super(container, "sidebar");
		this.topActivityBarHost = h(container.ownerDocument, 'div');
		this.topActivityBarHost.className = 'ash-sessions-activity-host top';
		this.topActivityBarHost.hidden = true;
		this.contentDomNode.append(this.topActivityBarHost);
		const tabs = h(container.ownerDocument, 'nav');
		tabs.className = 'ash-sessions-sidebar-tabs';
		tabs.setAttribute('aria-label', localize('sessions.sidebar.views', 'Sidebar views'));
		this.chatTab = h(container.ownerDocument, 'button');
		this.chatTab.type = 'button';
		this.chatTab.textContent = localize('sessions.sidebar.chats', 'Chats');
		this.teamsTab = h(container.ownerDocument, 'button');
		this.teamsTab.type = 'button';
		this.teamsTab.textContent = localize('sessions.sidebar.teams', 'Teams');
		tabs.append(this.chatTab, this.teamsTab);
		this.contentDomNode.append(tabs);
		this.list = this._register(new SessionsList(this.contentDomNode, sessionService, viewService, "Sessions", "New session"));
		this.teams = this._register(new TeamsPanel(this.contentDomNode, teamsService, sessionService, quickInput, listRoles));
		this._register(addDisposableListener(this.chatTab, 'click', () => this.showChats()));
		this._register(addDisposableListener(this.teamsTab, 'click', () => { void this.showTeams(); }));
		this.updateTabs();
		this.bottomActivityBarHost = h(container.ownerDocument, 'div');
		this.bottomActivityBarHost.className = 'ash-sessions-activity-host bottom';
		this.bottomActivityBarHost.hidden = true;
		this.contentDomNode.append(this.bottomActivityBarHost);
	}

	focus(): void { this.activeTab === 'chats' ? this.list.focus() : this.teams.focus(); }

	focusChats(): void { this.showChats(); this.list.focus(); }

	private showChats(): void { this.activeTab = 'chats'; this.updateTabs(); }

	private async showTeams(): Promise<void> { this.activeTab = 'teams'; this.updateTabs(); await this.teams.show(); this.teams.focus(); }

	private updateTabs(): void {
		this.list.domNode.hidden = this.activeTab !== 'chats';
		this.teams.domNode.hidden = this.activeTab !== 'teams';
		this.chatTab.setAttribute('aria-current', this.activeTab === 'chats' ? 'page' : 'false');
		this.teamsTab.setAttribute('aria-current', this.activeTab === 'teams' ? 'page' : 'false');
	}

	setActivityBarLocation(location: ActivityBarPosition): HTMLElement | undefined {
		this.topActivityBarHost.hidden = location !== ActivityBarPosition.TOP;
		this.bottomActivityBarHost.hidden = location !== ActivityBarPosition.BOTTOM;
		if (location === ActivityBarPosition.TOP) return this.topActivityBarHost;
		if (location === ActivityBarPosition.BOTTOM) return this.bottomActivityBarHost;
		return undefined;
	}
}
