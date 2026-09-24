import "./media/sessionsTitlebarPart.css";
import "../common/sessionsControls.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import type { SessionsProfile } from "../../common/sessionsProfile.js";
import type { ISessionsService } from "../../services/view/common/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";

export interface SessionsTitlebarPartDelegate {
	returnToWorkbench(): void;
	focusSessions(): void;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class SessionsTitlebarPart extends WorkbenchPart {
	override get minimumHeight(): number { return 46; }
	override get maximumHeight(): number { return 46; }

	constructor(container: HTMLElement, profile: SessionsProfile, viewService: ISessionsService, delegate: SessionsTitlebarPartDelegate) {
		super(container, "titlebar");
		const ownerDocument = container.ownerDocument;
		const returnButton = h(ownerDocument, "button");
		returnButton.type = "button";
		returnButton.className = "ash-sessions-button ash-sessions-titlebar-button";
		returnButton.textContent = "Workbench";
		const backButton = navigationButton(ownerDocument, "←", "Back");
		const forwardButton = navigationButton(ownerDocument, "→", "Forward");
		const title = h(ownerDocument, "div");
		title.className = "ash-sessions-titlebar-title";
		title.textContent = profile.label;
		const newSession = h(ownerDocument, "button");
		newSession.type = "button";
		newSession.className = "ash-sessions-button ash-sessions-titlebar-new-session";
		newSession.textContent = "New session";
		this.contentDomNode.append(returnButton, backButton, forwardButton, title, newSession);
		this._register(addDisposableListener(returnButton, "click", () => delegate.returnToWorkbench()));
		this._register(addDisposableListener(backButton, "click", () => viewService.navigateBack()));
		this._register(addDisposableListener(forwardButton, "click", () => viewService.navigateForward()));
		this._register(addDisposableListener(newSession, "click", () => {
			viewService.openNewSession("New code session");
			delegate.focusSessions();
		}));
		const updateNavigation = (): void => {
			backButton.disabled = !viewService.canNavigateBack;
			forwardButton.disabled = !viewService.canNavigateForward;
			const selection = viewService.activeSelection;
			title.textContent = selection?.kind === "session"
				? selection.active.session.title.trim() || profile.label
				: selection?.kind === "untitled" ? selection.session.title.trim() || profile.label : profile.label;
			title.title = title.textContent;
		};
		this._register(viewService.onDidChange(updateNavigation));
		updateNavigation();
	}
}

function navigationButton(ownerDocument: Document, label: string, ariaLabel: string): HTMLButtonElement {
	const button = h(ownerDocument, "button");
	button.type = "button";
	button.className = "ash-sessions-navigation-button";
	button.textContent = label;
	button.setAttribute("aria-label", ariaLabel);
	button.title = ariaLabel;
	return button;
}
