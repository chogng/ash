import "./media/sidebarPart.css";
import { h } from '../../../base/browser/dom.js';
import { ActivityBarPosition } from '../../../workbench/common/configuration.js';
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import { SessionsList } from "./sessionsList.js";

/** Session navigation Part for the dedicated Sessions Workbench. */
export class SidebarPart extends WorkbenchPart {
	private readonly list: SessionsList;
	private readonly topActivityBarHost: HTMLDivElement;
	private readonly bottomActivityBarHost: HTMLDivElement;

	override get minimumWidth(): number { return 240; }
	override get maximumWidth(): number { return 520; }

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService) {
		super(container, "sidebar");
		this.topActivityBarHost = h(container.ownerDocument, 'div');
		this.topActivityBarHost.className = 'ash-sessions-activity-host top';
		this.topActivityBarHost.hidden = true;
		this.contentDomNode.append(this.topActivityBarHost);
		this.list = this._register(new SessionsList(this.contentDomNode, sessionService, viewService, "Sessions", "New session"));
		this.bottomActivityBarHost = h(container.ownerDocument, 'div');
		this.bottomActivityBarHost.className = 'ash-sessions-activity-host bottom';
		this.bottomActivityBarHost.hidden = true;
		this.contentDomNode.append(this.bottomActivityBarHost);
	}

	focus(): void { this.list.focus(); }

	setActivityBarLocation(location: ActivityBarPosition): HTMLElement | undefined {
		this.topActivityBarHost.hidden = location !== ActivityBarPosition.TOP;
		this.bottomActivityBarHost.hidden = location !== ActivityBarPosition.BOTTOM;
		if (location === ActivityBarPosition.TOP) return this.topActivityBarHost;
		if (location === ActivityBarPosition.BOTTOM) return this.bottomActivityBarHost;
		return undefined;
	}
}
