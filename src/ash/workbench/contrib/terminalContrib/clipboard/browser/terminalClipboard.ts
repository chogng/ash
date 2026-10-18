import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';

/** Returns the user's decision, or text with an auto-executing trailing newline removed. */
export async function shouldPasteTerminalText(accessor: ServicesAccessor, text: string, bracketedPasteMode: boolean | undefined): Promise<boolean | { modifiedText: string; }> {
	if (!/[\r\n]/u.test(text)) return true;
	const policy = accessor.get(IConfigurationService).getValue<string>(TerminalSettingId.EnableMultiLinePasteWarning);
	if (policy === 'never' || (policy !== 'always' && bracketedPasteMode)) return true;
	if (policy !== 'always') {
		const command = text.trimEnd();
		if (!/[\r\n]/u.test(command)) return { modifiedText: command };
	}

	// Bound the preview independently of the paste, which must retain the original text.
	const preview = text.replace(/\r\n|\r/gu, '\n').slice(0, 2000).split('\n').slice(0, 10).join('\n');
	const result = await accessor.get(IDialogService).confirm({
		title: localize('terminal.clipboard.confirmTitle', 'Paste into Terminal'),
		message: localize('terminal.clipboard.confirmMessage', 'Paste multiple lines into the terminal?'),
		detail: localize('terminal.clipboard.confirmDetail', 'This text may run commands. Review the beginning of the text before pasting:\n\n{0}', preview),
		primaryButton: localize('terminal.clipboard.confirmPaste', 'Paste'),
		cancelButton: localize('terminal.clipboard.confirmCancel', 'Cancel'),
	});
	return result.confirmed;
}
