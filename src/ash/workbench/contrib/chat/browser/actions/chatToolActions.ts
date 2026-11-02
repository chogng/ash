import { isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { IChatWidgetService } from '../chat.js';
import { createToolSelectionAttachment, showToolsPicker } from './chatToolPicker.js';

export const AcceptToolConfirmationActionId = 'workbench.action.chat.acceptTool';
export const SkipToolConfirmationActionId = 'workbench.action.chat.skipTool';
export const AcceptToolPostConfirmationActionId = 'workbench.action.chat.acceptToolPostExecution';
export const SkipToolPostConfirmationActionId = 'workbench.action.chat.skipToolPostExecution';

/** Commands act only on the approval currently presented by the focused composer. */
export function registerChatToolActions(): DisposableStore {
	const store = new DisposableStore();
	for (const [id, title, operation] of [
		[AcceptToolConfirmationActionId, localize2('chat.tools.accept', 'Chat: Approve Tool Once'), 'acceptActiveToolConfirmation'],
		[SkipToolConfirmationActionId, localize2('chat.tools.skip', 'Chat: Decline Tool'), 'skipActiveToolConfirmation'],
		[AcceptToolPostConfirmationActionId, localize2('chat.resultReview.shareCommand', 'Chat: Share Tool Results'), 'acceptActiveToolPostConfirmation'],
		[SkipToolPostConfirmationActionId, localize2('chat.resultReview.skipCommand', 'Chat: Skip Tool Results'), 'skipActiveToolPostConfirmation'],
	] as const) {
		store.add(registerAction2(class extends Action2 {
			constructor() { super({ id, title, f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
			public override async run(accessor: ServicesAccessor): Promise<void> {
				const widgets = accessor.get(IChatWidgetService);
				const widget = widgets.lastFocusedWidget;
				if (!widget?.visible || !widget.sessionId || !widget.threadId) { return; }
				const { sessionId, threadId } = widget;
				let retired = false;
				using lifetime = new DisposableStore();
				lifetime.add(widget.onDidChangeViewModel(() => { retired = true; }));
				lifetime.add(widget.onDidHide(() => { retired = true; }));
				await widget.input[operation]();
				if (!retired && widgets.getAllWidgets().includes(widget) && widget.visible && widget.sessionId === sessionId && widget.threadId === threadId) { widget.focusInput(); }
			}
		}));
	}
	store.add(registerAction2(ConfigureToolsAction));
	return store;
}

export class ConfigureToolsAction extends Action2 {
	public static readonly ID = 'workbench.action.chat.configureTools';
	constructor() {
		super({
			id: ConfigureToolsAction.ID, title: localize2('chat.tools.configureCommand', 'Chat: Configure Tools'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true)
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (!widget?.visible) { return; }
		const tools = accessor.get(ILanguageModelToolsService);
		const quickInput = accessor.get(IQuickInputService);
		if (!tools.isAvailable) { return; }
		try {
			await widget.acquireContext(async signal => {
				await tools.refresh();
				if (signal.aborted) { return []; }
				const selection = widget.input.attachmentModel.attachments.find(attachment => attachment.kind === 'toolSelection');
				const disabled: readonly string[] = selection ? JSON.parse((await selection.resolve()).content) : [];
				if (signal.aborted) { return []; }
				const result = await showToolsPicker(quickInput, tools, disabled, signal);
				return result && !signal.aborted ? [createToolSelectionAttachment(result)] : [];
			});
		} catch (error) {
			if (!isCancellationError(error)) { throw error; }
		}
	}
}
