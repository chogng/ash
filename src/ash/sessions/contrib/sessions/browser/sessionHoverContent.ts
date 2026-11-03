import { h } from '../../../../base/browser/dom.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { IChat, ISession } from '../../../services/sessions/common/session.js';

export function getSessionSummaryHoverData(session: ISession, chat?: IChat): readonly string[] {
	const workspace = chat?.workspace ?? session.workspace;
	const provider = session.providerLabel ?? session.application?.label;
	const updatedAt = chat?.updatedAt;
	const details: string[] = [];
	if (workspace) {
		details.push(localize('sessions.hover.workspace', 'Workspace: {0}', workspace.root));
	}
	if (provider) {
		details.push(localize('sessions.hover.provider', 'Provider: {0}', provider));
	}
	if (updatedAt && Number.isFinite(updatedAt.getTime())) {
		details.push(localize('sessions.hover.updated', 'Updated: {0}', updatedAt.toLocaleString(getNLSLanguage())));
	}
	return details;
}

export function createSessionSummaryHover(document: Document, title: string, details: readonly string[]): HTMLElement {
	return h(document, 'div', h(document, 'strong', title), ...details.map(detail => h(document, 'div', detail)));
}
