import './media/navigationBarPart.css';
import { addDisposableListener, h } from '../../../base/browser/dom.js';
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import type { Icon } from '../../../base/common/icon.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize } from '../../../nls.js';
import { WorkbenchPart } from '../../../workbench/browser/part.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';

export interface NavigationBarPartDelegate {
	focusList(): void;
	focusChat(): void;
	toggleDetails(): void;
}

/** Persistent window navigation beside the Sessions list. */
export class NavigationBarPart extends WorkbenchPart {
	private readonly sessionsButton: HTMLButtonElement;
	private readonly detailsButton: HTMLButtonElement;

	override get minimumWidth(): number { return 56; }
	override get maximumWidth(): number { return 56; }

	constructor(container: HTMLElement, viewService: ISessionsService, delegate: NavigationBarPartDelegate) {
		super(container, 'navigationbar');
		const ownerDocument = container.ownerDocument;
		const top = h(ownerDocument, 'div');
		top.className = 'ash-sessions-navigation-top';
		const bottom = h(ownerDocument, 'div');
		bottom.className = 'ash-sessions-navigation-bottom';
		this.sessionsButton = this.addButton(top, Lxicon.chatFilled, localize('sessions.navigation.sessions', 'Sessions'), () => delegate.focusList());
		this.sessionsButton.classList.add('selected');
		this.sessionsButton.setAttribute('aria-current', 'page');
		this.addButton(top, Lxicon.add, localize('sessions.navigation.new', 'New session'), () => {
			viewService.openNewSession(localize('sessions.newCodeSession', 'New code session'));
			delegate.focusChat();
		});
		const back = this.addButton(top, Lxicon.arrowLeft, localize('sessions.navigation.back', 'Back'), () => viewService.navigateBack());
		const forward = this.addButton(top, Lxicon.arrowRight, localize('sessions.navigation.forward', 'Forward'), () => viewService.navigateForward());
		this.detailsButton = this.addButton(bottom, Lxicon.layoutSidebarRight, localize('sessions.navigation.details', 'Session details'), () => delegate.toggleDetails());
		const update = (): void => {
			back.disabled = !viewService.canNavigateBack;
			forward.disabled = !viewService.canNavigateForward;
		};
		this.contentDomNode.append(top, bottom);
		this._register(viewService.onDidChange(update));
		update();
	}

	private addButton(container: HTMLElement, icon: Icon, label: string, action: () => void): HTMLButtonElement {
		const button = h(container.ownerDocument, 'button');
		button.type = 'button';
		button.className = 'ash-sessions-navigation-item';
		button.setAttribute('aria-label', label);
		button.title = label;
		appendIcon(icon, button);
		container.append(button);
		this._register(addDisposableListener(button, 'click', action));
		return button;
	}

	updateDetailsVisibility(visible: boolean): void {
		this.detailsButton.classList.toggle('selected', visible);
		this.detailsButton.setAttribute('aria-pressed', String(visible));
	}

	updateHelpHint(hint: string | undefined): void {
		const label = localize('sessions.navigation.sessions', 'Sessions');
		this.sessionsButton.setAttribute('aria-label', hint
			? localize('sessions.navigation.helpHint', '{0}. {1}', label, hint)
			: label);
	}
}
