import "../../common/sessionsColors.js";
import "./media/titlebarpart.css";
import "./media/sessionsControls.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize } from '../../../nls.js';
import { environment } from "../../../base/common/platform.js";
import type { SessionsProfile } from "../../common/sessionsProfile.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";

export interface TitlebarPartDelegate {
	returnToWorkbench(): void;
	focusSessions(): void;
	toggleDetails(): void;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WorkbenchPart {
	private readonly detailsButton: HTMLButtonElement;

	override get minimumHeight(): number { return 46; }
	override get maximumHeight(): number { return 46; }

	constructor(container: HTMLElement, profile: SessionsProfile, viewService: ISessionsService, delegate: TitlebarPartDelegate) {
		super(container, "titlebar");
		this.domNode.classList.add("ash-sessions-titlebar");
		const ownerDocument = container.ownerDocument;
		const left = h(ownerDocument, "div");
		left.className = "ash-sessions-titlebar-left";
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
		returnButton.setAttribute('aria-label', localize('sessions.titlebar.workbench', 'Return to Workbench'));
		returnButton.title = returnButton.getAttribute('aria-label')!;
		appendIcon(Lxicon.layoutSidebarRightOff1, returnButton);
		const backButton = navigationButton(ownerDocument, '←', localize('sessions.navigation.back', 'Back'));
		const forwardButton = navigationButton(ownerDocument, '→', localize('sessions.navigation.forward', 'Forward'));
		const title = h(ownerDocument, "div");
		title.className = "ash-sessions-titlebar-title";
		title.textContent = profile.label;
		const avatar = h(ownerDocument, 'span');
		avatar.className = 'ash-sessions-titlebar-avatar';
		avatar.setAttribute('aria-hidden', 'true');
		appendIcon(Lxicon.agent, avatar);
		const newSession = h(ownerDocument, "button");
		newSession.type = "button";
		newSession.className = "ash-sessions-button ash-sessions-titlebar-new-session";
		newSession.setAttribute('aria-label', localize('sessions.navigation.new', 'New session'));
		newSession.title = newSession.getAttribute('aria-label')!;
		appendIcon(Lxicon.add, newSession);
		this.detailsButton = h(ownerDocument, 'button');
		this.detailsButton.type = 'button';
		this.detailsButton.className = 'ash-sessions-button ash-sessions-titlebar-button';
		this.detailsButton.setAttribute('aria-label', localize('sessions.navigation.details', 'Session details'));
		this.detailsButton.title = this.detailsButton.getAttribute('aria-label')!;
		appendIcon(Lxicon.layoutSidebarRightOff1, this.detailsButton);
		left.append(avatar, title);
		navigation.append(backButton, forwardButton);
		right.append(navigation, newSession, this.detailsButton, returnButton);
		this.contentDomNode.append(left, right);
		this._register(addDisposableListener(returnButton, "click", () => delegate.returnToWorkbench()));
		this._register(addDisposableListener(backButton, "click", () => viewService.navigateBack()));
		this._register(addDisposableListener(forwardButton, "click", () => viewService.navigateForward()));
		this._register(addDisposableListener(newSession, "click", () => {
			viewService.openNewSession(localize('sessions.newCodeSession', 'New code session'));
			delegate.focusSessions();
		}));
		this._register(addDisposableListener(this.detailsButton, 'click', () => delegate.toggleDetails()));
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

	public updateDetailsVisibility(visible: boolean): void {
		this.detailsButton.classList.toggle('selected', visible);
		this.detailsButton.setAttribute('aria-pressed', String(visible));
		this.detailsButton.replaceChildren();
		appendIcon(visible ? Lxicon.layoutSidebarRight1 : Lxicon.layoutSidebarRightOff1, this.detailsButton);
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
