import { URI } from '../../../../base/common/uri.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { MultiDiffEditorFileListContextMenu } from '../../../../workbench/contrib/multiDiffEditor/common/multiDiffEditor.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { CHANGESET_REVIEW_ACTION_ID, ChangesScopeContext, SessionChangesEditor } from './sessionChangesEditor.js';

export class ChangesetReviewAction extends Action2 {
	constructor() {
		super({
			id: CHANGESET_REVIEW_ACTION_ID, title: localize2('sessions.changes.viewed', 'Viewed'),
			icon: Lxicon.check,
			precondition: ContextKeyExpr.has('sessions.changesCanReview'),
			toggled: ContextKeyExpr.in('resource', 'sessions.changesReviewedFiles'),
			menu: { id: MenuId.MultiDiffEditorFileToolbar, when: ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID), group: 'navigation', order: 1 },
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const argument = args[0];
		const resource = argument instanceof URI ? argument : isRecord(argument) ? argument.resource : undefined;
		if (resource instanceof URI) await updateReviewState(accessor, [resource]);
	}
}

async function updateReviewState(accessor: ServicesAccessor, resources: readonly URI[], reviewed?: boolean): Promise<void> {
	const editors = accessor.get(IEditorPart);
	const pane = editors.activePane;
	if (!(pane instanceof SessionChangesEditor) || !resources.length) return;
	const state = accessor.get(IChangesViewService);
	const reviewedAtStart = state.reviewedFilesObs.get();
	let previous = reviewedAtStart;
	const changedResources = new Set<string>();
	// A later edit supersedes the operation even if it returns a file to its original state.
	using reviewChanges = state.reviewedFilesObs.onDidChange(() => {
		const current = state.reviewedFilesObs.get();
		for (const uri of previous) { if (!current.has(uri)) changedResources.add(uri); }
		for (const uri of current) { if (!previous.has(uri)) changedResources.add(uri); }
		previous = current;
	});
	const changes = await Promise.all(resources.map(async resource => {
		const change = await pane.getFileChange(resource, { review: true }).catch(error => {
			if (isCancellationError(error) || editors.activePane !== pane) return undefined;
			throw error;
		});
		return change && { resource, uri: change.uri };
	}));
	if (editors.activePane !== pane) return;
	const applicable = changes.filter((change): change is NonNullable<typeof change> => !!change && !changedResources.has(change.uri.toString()));
	if (!applicable.length) return;
	const next = reviewed ?? !reviewedAtStart.has(applicable[0]!.uri.toString());
	state.setChangesetFilesReviewState(applicable.map(change => change.uri), next);
	for (const change of applicable) pane.setFileCollapsed(change.resource, next);
}

registerAction2(ChangesetReviewAction);

for (const [reviewed, id, title] of [
	[true, 'changeset.markReviewed', localize2('sessions.changes.markReviewed', 'Mark reviewed')],
	[false, 'changeset.markUnreviewed', localize2('sessions.changes.markUnread', 'Mark unreviewed')],
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id, title, menu: {
					id: MultiDiffEditorFileListContextMenu, group: 'navigation',
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', SessionChangesEditor.ID),
						ContextKeyExpr.or(ChangesScopeContext.isEqualTo('all'), ChangesScopeContext.isEqualTo('turn'))),
				}
			});
		}
		async run(accessor: ServicesAccessor, items: unknown): Promise<void> {
			if (!Array.isArray(items)) return;
			const resources = items.flatMap(item => isRecord(item) && isRecord(item.modified) && item.modified.resource instanceof URI ? [item.modified.resource] : []);
			await updateReviewState(accessor, resources, reviewed);
		}
	});
}
