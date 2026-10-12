import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { CHANGESET_REVIEW_ACTION_ID, SessionChangesEditor } from './sessionChangesEditor.js';

export class ChangesetReviewAction extends Action2 {
	constructor() {
		super({
			id: CHANGESET_REVIEW_ACTION_ID, title: localize2('sessions.changes.viewed', 'Viewed'),
			precondition: ContextKeyExpr.has('sessions.changesCanReview'),
			toggled: ContextKeyExpr.in('resource', 'sessions.changesReviewedFiles'),
			menu: { id: MenuId.MultiDiffEditorFileToolbar, when: ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID), group: 'navigation', order: 1 },
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const argument = args[0];
		const resource = argument instanceof URI ? argument : isRecord(argument) ? argument.resource : undefined;
		if (!(resource instanceof URI)) { return; }
		const editors = accessor.get(IEditorPart);
		const pane = editors.activePane;
		if (!(pane instanceof SessionChangesEditor)) { return; }
		const change = await pane.getFileChange(resource, { review: true });
		if (!change || editors.activePane !== pane) { return; }
		const state = accessor.get(IChangesViewService);
		const reviewed = !state.reviewedFilesObs.get().has(change.uri.toString());
		state.setChangesetFilesReviewState([change.uri], reviewed);
		if (reviewed) { pane.collapse(resource); } else { pane.expand(resource); }
	}
}

registerAction2(ChangesetReviewAction);
