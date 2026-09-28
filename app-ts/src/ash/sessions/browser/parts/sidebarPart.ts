import "./media/sidebarPart.css";
import { h } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import type { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { ActivityBarPosition } from '../../../workbench/common/configuration.js';
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import { SessionsList } from "./sessionsList.js";
import { TeamsPanel, type TeamRoleOption } from './teamsPanel.js';
import type { ITeamsManagementService } from '../../services/teams/common/teamsManagement.js';

/** Session navigation Part for the dedicated Sessions Workbench. */
export type SidebarView = 'chats' | 'teams';

export class SidebarPart extends WorkbenchPart {
	private readonly list: SessionsList;
	private readonly teams: TeamsPanel;
	private activeView: SidebarView = 'chats';
	private readonly didChangeView = this._register(new Emitter<SidebarView>());
	public readonly onDidChangeView = this.didChangeView.event;
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
		this.list = this._register(new SessionsList(this.contentDomNode, sessionService, viewService, "Sessions", "New session"));
		this.teams = this._register(new TeamsPanel(this.contentDomNode, teamsService, sessionService, quickInput, listRoles));
		this.bottomActivityBarHost = h(container.ownerDocument, 'div');
		this.bottomActivityBarHost.className = 'ash-sessions-activity-host bottom';
		this.bottomActivityBarHost.hidden = true;
		this.contentDomNode.append(this.bottomActivityBarHost);
	}

	focus(): void { this.activeView === 'chats' ? this.list.focus() : this.teams.focus(); }

	focusChats(): void { this.selectView('chats'); this.list.focus(); }

	public get currentView(): SidebarView { return this.activeView; }

	public selectView(view: SidebarView): void {
		if (this.activeView === view) return;
		this.activeView = view;
		this.list.domNode.hidden = view !== 'chats';
		this.teams.domNode.hidden = view !== 'teams';
		this.didChangeView.fire(view);
		if (view === 'teams') void this.teams.show().then(() => {
			if (this.activeView === 'teams') this.teams.focus();
		});
	}

	setEmptyPage(empty: boolean): void {
		this.contentDomNode.classList.toggle('empty-page', empty);
	}

	setActivityBarLocation(location: ActivityBarPosition): HTMLElement | undefined {
		this.topActivityBarHost.hidden = location !== ActivityBarPosition.TOP;
		this.bottomActivityBarHost.hidden = location !== ActivityBarPosition.BOTTOM;
		if (location === ActivityBarPosition.TOP) return this.topActivityBarHost;
		if (location === ActivityBarPosition.BOTTOM) return this.bottomActivityBarHost;
		return undefined;
	}
}
