import { addDisposableListener, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export const MOUSE_BACK_FORWARD_NAVIGATION_SETTING = 'workbench.editor.mouseBackForwardToNavigate';

export class SessionsMouseNavigationContribution extends Disposable {
	static readonly ID = 'workbench.contrib.sessionsMouseNavigation';

	constructor(
		@IConfigurationService configuration: IConfigurationService,
		@ILayoutService layout: ILayoutService,
		@ISessionsService sessions: ISessionsService,
	) {
		super();
		const container = layout.mainContainer;
		const handle = (event: MouseEvent): void => {
			if ((event.button !== 3 && event.button !== 4) || !configuration.getValue<boolean>(MOUSE_BACK_FORWARD_NAVIGATION_SETTING)) return;
			const active = getActiveElement(container.ownerDocument);
			if (isHTMLElement(active) && active.closest('[data-part="editor"]')) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.type === 'mousedown') {
				const navigation = event.button === 3 ? sessions.openPreviousSession() : sessions.openNextSession();
				void navigation.catch(onUnexpectedError);
			}
		};
		for (const event of ['mousedown', 'mouseup', 'auxclick'] as const) {
			this._register(addDisposableListener(container, event, handle, true));
		}
	}
}
