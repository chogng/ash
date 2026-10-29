import { environment } from '../../../../base/common/platform.js';
import { IDialogsModel, IWorkbenchDialogHandler } from '../../../common/dialogs.js';
import { DialogHandlerContribution } from '../../../browser/parts/dialogs/dialog.web.contribution.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

if (environment.runtime === 'electron') {
	registerWorkbenchContribution(
		'workbench.contrib.dialogHandler',
		WorkbenchPhase.BlockStartup,
		accessor => new DialogHandlerContribution(
			accessor.get(IDialogsModel),
			accessor.get(IWorkbenchDialogHandler),
		),
	);
}
