import "../../common/sessionsColors.js";
import "./media/titlebarpart.css";
import "./media/sessionsControls.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import { environment } from "../../../base/common/platform.js";
import type { SessionsProfile } from "../../common/sessionsProfile.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";

export interface TitlebarPartDelegate {
	returnToWorkbench(): void;
	focusSessions(): void;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WorkbenchPart {
	override get minimumHeight(): number { return 46; }
	override get maximumHeight(): number { return 46; }

	constructor(container: HTMLElement, profile: SessionsProfile, viewService: ISessionsService, delegate: TitlebarPartDelegate) {
		super(container, "titlebar");
		this.domNode.classList.add("ash-sessions-titlebar");
		const ownerDocument = container.ownerDocument;
		const left = h(ownerDocument, "div");
		left.className = "ash-sessions-titlebar-left";
		const center = h(ownerDocument, "div");
		center.className = "ash-sessions-titlebar-center";
		const navigation = h(ownerDocument, "div");
		navigation.className = "ash-sessions-titlebar-navigation";
		const right = h(ownerDocument, "div");
		right.className = "ash-sessions-titlebar-right";
		if (environment.runtime === "electron" && environment.os === "mac") {
			const windowControlsSpacer = h(ownerDocument, "div");
			windowControlsSpacer.className = "ash-sessions-window-controls-spacer";
			windowControlsSpacer.setAttribute("aria-hidden", "true");
			left.append(windowControlsSpacer);
		}
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
		left.append(returnButton);
		navigation.append(backButton, forwardButton);
		center.append(navigation, title);
		right.append(newSession);
		this.contentDomNode.append(left, center, right);
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
