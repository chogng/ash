import "./media/sidebarPart.css";
import { h } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import type { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { ActivityBarPosition } from '../../../workbench/common/configuration.js';
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { SidebarPart as WorkbenchSidebarPart } from '../../../workbench/browser/parts/sidebar/sidebarPart.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { SessionsList } from "./sessionsList.js";
import { TeamsPanel, type TeamRoleOption } from './teamsPanel.js';
import type { ITeamsManagementService } from '../../services/teams/common/teamsManagement.js';
import { SESSION_SIDEBAR_DEFAULT_WIDTH } from '../../common/layoutConstants.js';

/** Session navigation Part for the dedicated Sessions Workbench. */
export type SidebarView = 'chats' | 'teams' | 'views';

export class SidebarPart extends WorkbenchSidebarPart {
	private readonly list: SessionsList;
	private readonly teams: TeamsPanel;
	private activeView: SidebarView = 'chats';
	private readonly didChangeView = this._register(new Emitter<SidebarView>());
	public readonly onDidChangeView = this.didChangeView.event;
	private readonly topActivityBarHost: HTMLDivElement;
	private readonly bottomActivityBarHost: HTMLDivElement;

	override get minimumWidth(): number { return 240; }
	override get maximumWidth(): number { return 520; }
	override get preferredWidth(): number {
		const width = this.activeCompositeId ? this.getComposite(this.activeCompositeId)!.getOptimalWidth() : 0;
		return Math.max(SESSION_SIDEBAR_DEFAULT_WIDTH, width);
	}

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService, teamsService: ITeamsManagementService, quickInput: IQuickInputService, listRoles: () => Promise<readonly TeamRoleOption[]>,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
	) {
		super(container, { viewDescriptorService: descriptors, contextKeyService: contextKeys, storageService: storage, compositeBarVisible: false });
		this.titleDomNode.hidden = true;
		this.topActivityBarHost = h(container.ownerDocument, 'div');
		this.topActivityBarHost.className = 'ash-sessions-activity-host top';
		this.topActivityBarHost.hidden = true;
		this.domNode.insertBefore(this.topActivityBarHost, this.titleDomNode);
		this.list = this._register(new SessionsList(this.contentDomNode, sessionService, viewService, "Sessions", "New session"));
		this.teams = this._register(new TeamsPanel(this.contentDomNode, teamsService, viewService, quickInput, listRoles));
		this.bottomActivityBarHost = h(container.ownerDocument, 'div');
		this.bottomActivityBarHost.className = 'ash-sessions-activity-host bottom';
		this.bottomActivityBarHost.hidden = true;
		this.contentDomNode.append(this.bottomActivityBarHost);
	}

	public override getPaneCompositeOptions(): ReturnType<WorkbenchSidebarPart['getPaneCompositeOptions']> {
		return { paneLayout: 'fill', mergeViewWithContainerWhenSingleView: true };
	}
	focus(): void {
		if (this.activeView === 'views') this.getComposite(this.activeCompositeId!)?.focus();
		else if (this.activeView === 'chats') this.list.focus();
		else this.teams.focus();
	}

	public override showComposite(id: string): void {
		this.selectView('views');
		super.showComposite(id);
		const composite = this.getComposite(id)!;
		this.contentDomNode.insertBefore(composite.element, this.bottomActivityBarHost);
		composite.setVisible(!this.domNode.hidden);
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (this.activeView !== 'views' && this.activeCompositeId) this.getComposite(this.activeCompositeId)!.setVisible(false);
	}

	focusChats(): void { this.selectView('chats'); this.list.focus(); }

	public get currentView(): SidebarView { return this.activeView; }

	public selectView(view: SidebarView): void {
		if (this.activeView === view) return;
		this.activeView = view;
		this.list.domNode.hidden = view !== 'chats';
		this.teams.domNode.hidden = view !== 'teams';
		this.titleDomNode.hidden = view !== 'views';
		if (view !== 'views' && this.activeCompositeId) this.getComposite(this.activeCompositeId)!.setVisible(false);
		this.didChangeView.fire(view);
		if (view === 'teams') void this.teams.show().then(() => {
			if (this.activeView === 'teams') this.teams.focus();
		});
	}

	override setActivityBarLocation(location: ActivityBarPosition): HTMLElement | undefined {
		this.topActivityBarHost.hidden = location !== ActivityBarPosition.TOP;
		this.bottomActivityBarHost.hidden = location !== ActivityBarPosition.BOTTOM;
		if (location === ActivityBarPosition.TOP) return this.topActivityBarHost;
		if (location === ActivityBarPosition.BOTTOM) return this.bottomActivityBarHost;
		return undefined;
	}
}
