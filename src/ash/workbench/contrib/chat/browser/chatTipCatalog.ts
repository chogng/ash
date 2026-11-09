import { localize } from '../../../../nls.js';

/** Built-in tips for features available in the native Code composer. */
export const TIP_CATALOG = [
	{
		id: 'attach-files',
		message: () => localize('chat.tip.attachFiles', 'Tip: Attach text files or images with the + button. You can also paste or drop images into your message.'),
	},
	{
		id: 'plan',
		message: () => localize('chat.tip.plan', 'Tip: Choose Plan in the mode picker to investigate and plan before making changes.'),
	},
	{
		id: 'background-send',
		message: () => localize('chat.tip.backgroundSend', 'Tip: Use Send in Background from the Command Palette to start a task and keep this input available.'),
	},
	{
		id: 'new-worktree',
		message: () => localize('chat.tip.newWorktree', 'Tip: Enable New worktree in the project picker to work in a separate Git checkout.'),
	},
];
