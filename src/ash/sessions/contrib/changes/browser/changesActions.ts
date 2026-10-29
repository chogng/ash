import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';
import { getChangesEditorLabels } from './changesEditorLabels.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesetOperationStatus } from '../../../services/sessions/common/session.js';

class OpenChangedFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.openFile',
			title: localize2('sessions.changes.openFile', 'Open File'),
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID),
				group: 'navigation',
				order: 22,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const argument = args[0];
		const resource = argument instanceof URI ? argument : isRecord(argument) ? argument.resource : undefined;
		if (!(resource instanceof URI)) {
			return;
		}
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof SessionChangesEditor)) {
			return;
		}
		const change = await pane.getFileChange(resource);
		if (!change) {
			return;
		}
		const session = accessor
			.get(ISessionsManagementService)
			.sessions.find(session => session.sessionId === change.summary.sessionId);
		const workspace =
			session?.chats.find(chat => chat.threadId === change.summary.threadId)?.workspace ?? session?.workspace;
		if (!workspace) {
			return;
		}
		const root = sessionWorkspaceUri(workspace);
		const fileResource = root.with({ path: `${root.path.replace(/\/$/u, '')}/${change.file.path}` });
		const labels = getChangesEditorLabels(fileResource, accessor.get(ILabelService));
		await accessor
			.get(IEditorService)
			.openEditor({ resource: fileResource, label: labels.label }, { pinned: true });
	}
}

registerAction2(OpenChangedFileAction);

async function setUnchangedRegions(accessor: ServicesAccessor, resource: unknown, enabled: boolean): Promise<void> {
	if (!(resource instanceof URI) && isRecord(resource)) {
		resource = resource.resource;
	}
	if (!(resource instanceof URI)) {
		return;
	}
	const pane = accessor.get(IEditorPart).activePane;
	if (!(pane instanceof SessionChangesEditor)) {
		return;
	}
	const change = await pane.getFileChange(resource);
	if (!change) {
		return;
	}
	// The shared comparison owns region folding; select the row receiving this action.
	pane.restoreViewState({ revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } });
	pane.getControl()?.updateOptions({ hideUnchangedRegions: { enabled } });
}

class ExpandFullFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.expandFullFile',
			title: localize2('sessions.changes.expandFullFile', 'Expand Full File'),
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID),
					ContextKeyExpr.not('multiDiffEditorFileIsBinary'),
				),
				group: 'navigation',
				order: 23,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await setUnchangedRegions(accessor, args[0], false);
	}
}

class CollapseUnchangedRegionsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.collapseUnchangedRegions',
			title: localize2('sessions.changes.collapseUnchanged', 'Collapse Unchanged Regions'),
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID),
					ContextKeyExpr.not('multiDiffEditorFileIsBinary'),
				),
				group: 'navigation',
				order: 24,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await setUnchangedRegions(accessor, args[0], true);
	}
}

registerAction2(ExpandFullFileAction);
registerAction2(CollapseUnchangedRegionsAction);

class PreviewChangesetFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.previewFile',
			title: localize2('sessions.changes.previewCommit', 'Preview commit…'),
			precondition: ContextKeyExpr.has('sessions.changesCanPreview'),
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID),
				group: 'navigation',
				order: 30,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const argument = args[0];
		const resource = argument instanceof URI ? argument : isRecord(argument) ? argument.resource : undefined;
		if (!(resource instanceof URI)) {
			return;
		}
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof SessionChangesEditor)) {
			return;
		}
		const change = await pane.getFileChange(resource);
		if (!change) {
			return;
		}
		const sessionResource = URI.from({
			scheme: 'ash-session',
			path: `/${change.summary.sessionId}`,
			query: new URLSearchParams({ thread: change.summary.threadId }).toString(),
		});
		const changeset = await accessor
			.get(ISessionChangesService)
			.resolveChangeset(sessionResource, change.summary.changeSetId);
		const operation = changeset.operations.get().find(operation => operation.id === 'preview');
		if (
			operation &&
			operation.status !== SessionChangesetOperationStatus.Disabled &&
			operation.status !== SessionChangesetOperationStatus.Running
		) {
			await changeset.invokeOperation(operation.id, { kind: 'resource', resource: change.uri });
		}
	}
}

registerAction2(PreviewChangesetFileAction);
