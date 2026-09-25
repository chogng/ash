import "./media/sidebarPart.css";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";
import { SessionsList } from "./sessionsList.js";

/** Session navigation Part for the dedicated Sessions Workbench. */
export class SidebarPart extends WorkbenchPart {
	private readonly list: SessionsList;

	override get minimumWidth(): number { return 190; }
	override get maximumWidth(): number { return 460; }

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService) {
		super(container, "sidebar");
		this.list = this._register(new SessionsList(this.contentDomNode, sessionService, viewService, "Sessions", "New session"));
	}

	focus(): void { this.list.focus(); }
}
