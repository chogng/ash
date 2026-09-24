import "./media/sessionsSidebarPart.css";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagementService.js";
import type { ISessionsService } from "../../services/view/common/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import { SessionsList } from "../common/sessionsList.js";

/** Session navigation Part for the dedicated Sessions Workbench. */
export class SessionsSidebarPart extends WorkbenchPart {
	private readonly list: SessionsList;

	override get minimumWidth(): number { return 190; }
	override get maximumWidth(): number { return 460; }

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService) {
		super(container, "sidebar");
		this.list = this._register(new SessionsList(this.contentDomNode, sessionService, viewService, "Sessions", "New session"));
	}

	focus(): void { this.list.focus(); }
}
