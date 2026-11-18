import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { IDialogOptions } from '../../../../base/browser/ui/dialog/dialog.js';
import { localize } from '../../../../nls.js';

interface WorkbenchDialogOptions extends Partial<IDialogOptions> {
	readonly shouldConfirmDiscard?: () => boolean;
}

export function createWorkbenchDialogOptions({ shouldConfirmDiscard, ...options }: WorkbenchDialogOptions): IDialogOptions {
	return {
		buttonStyles: defaultButtonStyles,
		checkboxStyles: defaultCheckboxStyles,
		inputBoxStyles: defaultInputBoxStyles,
		dialogStyles: defaultDialogStyles,
		...options,
		...(shouldConfirmDiscard && {
			confirmClose: {
				shouldConfirm: shouldConfirmDiscard,
				message: localize('dialog.discardChangesTitle', 'Discard unsaved changes?'),
				detail: localize('dialog.discardChangesDetail', 'Your changes haven’t been saved and will be lost.'),
				confirmButton: localize('dialog.discardChangesButton', 'Discard'),
				cancelButton: localize('dialog.keepEditingButton', 'Keep editing'),
				confirmPresentation: 'danger',
			},
		}),
	};
}
