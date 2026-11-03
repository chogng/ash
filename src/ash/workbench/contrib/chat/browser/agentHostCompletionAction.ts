import { localize } from '../../../../nls.js';
import { approvalModeDefinition, type ApprovalMode } from '../../../../platform/agentHost/common/approvalModes.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

/** Applies an explicit approval-mode selection to its original composer. */
export async function applyAgentHostCompletionAction(
	mode: ApprovalMode,
	confirm: IDialogService['confirm'],
	isCurrent: () => boolean,
	apply: (mode: ApprovalMode) => void,
): Promise<boolean> {
	if (!isCurrent()) return false;
	const definition = approvalModeDefinition(mode);
	if (definition.requiresConfirmation) {
		const result = await confirm({
			message: localize({ bundle: 'ash', key: 'sessions.chat.permission.fullWarning' }, 'Skip most permission approvals?'),
			detail: localize({ bundle: 'ash', key: 'sessions.chat.permission.fullDetail' }, 'Commands may change or delete files and perform external actions without asking. File and network access limits still apply. Plan and Ask remain analysis modes.'),
			primaryButton: localize(definition.label.key, definition.label.text),
		});
		if (!result.confirmed || !isCurrent()) return false;
	}
	apply(mode);
	return true;
}
