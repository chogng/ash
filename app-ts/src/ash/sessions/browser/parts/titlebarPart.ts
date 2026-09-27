import "../../common/sessionsColors.js";
import "./media/titlebarpart.css";
import "./media/sessionsControls.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize } from '../../../nls.js';
import { environment } from "../../../base/common/platform.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { WorkbenchPart } from "../../../workbench/browser/part.js";

export interface TitlebarPartDelegate {
	focusSessions(): void;
	toggleDetails(): void;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WorkbenchPart {
	private readonly detailsButton: HTMLButtonElement;

	override get minimumHeight(): number { return 46; }
	override get maximumHeight(): number { return 46; }

	constructor(container: HTMLElement, viewService: ISessionsService, delegate: TitlebarPartDelegate) {
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
		const backButton = navigationButton(ownerDocument, '←', localize('sessions.navigation.back', 'Back'));
		const forwardButton = navigationButton(ownerDocument, '→', localize('sessions.navigation.forward', 'Forward'));
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
		navigation.append(backButton, forwardButton);
		right.append(navigation, newSession, this.detailsButton);
		this.contentDomNode.append(left, right);
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
