import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DialogSeverity, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';

/** Returns the user's decision, including any explicitly requested newline removal. */
export async function shouldPasteTerminalText(accessor: ServicesAccessor, text: string, bracketedPasteMode: boolean | undefined): Promise<boolean | { modifiedText: string; }> {
	if (!/[\r\n]/u.test(text)) return true;
	const configuration = accessor.get(IConfigurationService);
	const policy = configuration.getValue<unknown>(TerminalSettingId.EnableMultiLinePasteWarning);
	// Profiles written before the string policy used false to disable warnings.
	if (policy === false || policy === 'never' || (policy !== 'always' && bracketedPasteMode)) return true;
	if (policy !== 'always') {
		const command = text.trimEnd();
		if (!/[\r\n]/u.test(command)) return { modifiedText: command };
	}

	// Bound the preview independently of the paste, which must retain the original text.
	const preview = text.replace(/\r\n|\r/gu, '\n').slice(0, 2000).split('\n').slice(0, 10).join('\n');
	const { result, checkboxChecked } = await accessor.get(IDialogService).prompt<'original' | 'singleLine'>({
		title: localize('terminal.clipboard.confirmTitle', 'Paste into Terminal'),
		severity: DialogSeverity.Warning,
		message: localize('terminal.clipboard.confirmMessage', 'Paste multiple lines into the terminal?'),
		detail: localize('terminal.clipboard.confirmDetail', 'This text may run commands. Review the beginning of the text before pasting:\n\n{0}', preview),
		buttons: [
			{ label: localize('terminal.clipboard.confirmPaste', 'Paste'), run: () => 'original' },
			{ label: localize('terminal.clipboard.pasteAsOneLine', 'Paste as One Line'), run: () => 'singleLine' },
		],
		cancelButton: localize('terminal.clipboard.confirmCancel', 'Cancel'),
		checkbox: { label: localize('terminal.clipboard.doNotAskAgain', 'Do Not Ask Again') },
	});
	if (!result) return false;
	if (checkboxChecked) await configuration.updateValue(TerminalSettingId.EnableMultiLinePasteWarning, 'never');
	// Remove line separators only: spaces and tabs still belong to the user's text.
	return result === 'singleLine' ? { modifiedText: text.replace(/[\r\n]/gu, '') } : true;
}
