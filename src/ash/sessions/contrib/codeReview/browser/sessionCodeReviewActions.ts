import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ChatResponseActionContext } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { codeReviewRequestPrefix, codeReviewResource, ISessionCodeReviewService } from './sessionCodeReviewService.js';

const title = localize2('sessions.codeReview.reviewChanges', 'Review Changes');

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.openCodeReview', title, icon: Lxicon.codeReview, f1: true,
			precondition: IsSessionsWindowContext.isEqualTo(true),
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const selection = accessor.get(ISessionsService).activeSelection;
		const target = selection?.kind === 'session'
			? { sessionId: selection.active.session.sessionId, threadId: selection.active.threadId }
			: undefined;
		await accessor.get(IEditorService).openEditor({
			resource: codeReviewResource(target),
		}, { pinned: true, revealIfOpened: true, forceReload: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.openResponseCodeReview',
			title: localize2('sessions.codeReview.comments', 'Review comments'),
			icon: Lxicon.comment,
			menu: {
				id: MenuId.ChatMessageFooter, group: 'navigation', order: 15,
				when: ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.regex(ChatContextKeys.responseRequestClientId.key, new RegExp(`^${codeReviewRequestPrefix}`))),
			},
		});
	}

	public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		if (!(context instanceof ChatResponseActionContext) || !context.visible) return;
		const { feedbackSource: target, requestClientId: id } = context.item;
		if (!target || !id?.startsWith(codeReviewRequestPrefix)) return;
		const snapshot = accessor.get(ISessionCodeReviewService).snapshotForMessage(target, id);
		if (!snapshot) throw new Error(localize('sessions.codeReview.missing', 'This review snapshot is unavailable.'));
		await accessor.get(IEditorService).openEditor({
			resource: codeReviewResource(snapshot.source, snapshot.batch.id),
		}, { pinned: true, revealIfOpened: true });
	}
});
