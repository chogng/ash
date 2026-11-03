import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { sessionResource } from '../../../browser/chatHistoryModel.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const detailsTitle = () => localize({ bundle: 'ash.sessions', key: 'sessions.details.editorTitle' }, 'Session Details');

function formatSessionDetails(catalog: readonly ISession[]): string {
	const entries = catalog.filter(session => session.status === 'active' && session.source !== 'automation');
	const lines = [detailsTitle(), ''];
	if (!entries.length) {
		lines.push(localize({ bundle: 'ash.sessions', key: 'sessions.details.empty' }, 'No non-archived user sessions.'));
	}
	for (const session of entries) {
		const title = session.title.trim().replace(/[\r\n]+/g, ' ') || localize('sessions.list.untitled', 'Untitled Session');
		lines.push(localize({ bundle: 'ash.sessions', key: 'sessions.details.name' }, 'Session: {0}', title));
		const workspace = session.workspace;
		if (workspace) {
			const path = workspace.authorityId === 'local' ? workspace.root : sessionWorkspaceUri(workspace).toString(true);
			lines.push(localize({ bundle: 'ash.sessions', key: 'sessions.details.directory' }, 'Working directory: {0}', path));
		} else {
			lines.push(localize({ bundle: 'ash.sessions', key: 'sessions.details.noDirectory' }, 'Working directory: (none)'));
		}
		lines.push(localize({ bundle: 'ash.sessions', key: 'sessions.details.resource' }, 'Resource: {0}', sessionResource('session', session.sessionId).toString()), '');
	}
	return lines.join('\n') + '\n';
}

registerAction2(class ShowSessionDetailsAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.showSessionDetails',
			title: localize2({ bundle: 'ash.sessions', key: 'sessions.details.command' }, 'Developer: Show Session Details'),
			f1: true,
			precondition: ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ChatContextKeys.enabled.isEqualTo(true)),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const catalog = accessor.get(ISessionsManagementService).sessions;
		await accessor.get(IEditorService).openEditor({
			resource: URI.from({ scheme: 'ash-session-details', path: '/sessions.txt', query: generateUuid() }),
			label: detailsTitle(),
			initialText: formatSessionDetails(catalog),
			languageId: 'plaintext',
			readOnly: true,
			showBreadcrumbs: false,
		}, { pinned: true });
	}
});
