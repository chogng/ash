import { DisposableStore } from "../../../base/common/lifecycle.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../platform/quickinput/common/quickInput.js";
import { NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import type { SessionId, ThreadId } from "../../services/sessions/common/session.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { localizedString } from '../../../platform/action/common/action.js';
import { approvalModeDefinitions } from '../../../platform/sessions/common/approvalModes.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import type { ModelReasoningEffort } from '../../../workbench/services/chat/common/modelCatalog.js';
import { localize } from '../../../nls.js';

for (const definition of approvalModeDefinitions) {
	const mode = definition.id;
	registerAction2(class SelectSessionApprovalMode extends Action2 {
		constructor() {
			super({
				id: `sessions.chat.permission.${mode}`,
				title: localizedString('ash', definition.label.key, definition.label.text),
			});
		}

		override async run(accessor: ServicesAccessor, model: IChatWidgetModel): Promise<void> {
			if (definition.requiresConfirmation) {
				const result = await accessor.get(IDialogService).confirm({
					message: localize('sessions.chat.permission.fullWarning', 'Skip most permission approvals?'),
					detail: localize('sessions.chat.permission.fullDetail', 'Commands may change or delete files and perform external actions without asking. File and network access limits still apply. Plan and Ask remain analysis modes.'),
					primaryButton: localize(definition.label.key, definition.label.text),
				});
				if (!result.confirmed) { return; }
			}
			// The menu carries its own composer model, including when another pane is active.
			model.selectApprovalMode(mode);
		}
	});
}

registerAction2(class SelectApprovalReviewModel extends Action2 {
	constructor() {
		super({ id: 'sessions.chat.permission.reviewModel', title: localizedString('ash', 'sessions.chat.permission.reviewModel', 'Review model…') });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const models = accessor.get(ILanguageModelsService);
		const input = accessor.get(IQuickInputService);
		const [selection, providers] = await Promise.all([models.readApprovalReviewModel(), models.listModelProviders()]);
		const connection = await selectReviewItem(input, localize('sessions.chat.permission.reviewConnection', 'Choose the review connection'), [
			{ label: localize('sessions.chat.permission.reviewDefault', 'Automatic (connection default)'), id: 'automatic', description: localize('sessions.chat.permission.reviewDefaults', 'ChatGPT subscription: codex-auto-review; OpenAI API: GPT-6 Luna, low') },
			...providers.filter(provider => provider.configured).map(provider => ({ label: provider.displayName, id: provider.connection, description: provider.connection })),
		], selection.type === 'explicit' ? selection.connection : 'automatic');
		if (!connection) { return; }
		if (connection.id === 'automatic') { await models.setApprovalReviewModel({ type: 'automatic' }); return; }
		const provider = providers.find(provider => provider.connection === connection.id)!;
		const catalog = (await models.listModelCatalog()).filter(entry => entry.model.provider === provider.provider);
		const choice = await selectReviewItem(input, localize('sessions.chat.permission.reviewModel', 'Review model…'), [
			...catalog.map(entry => ({ label: entry.displayName, id: entry.model.model, description: entry.model.model })),
			{ label: localize('sessions.chat.permission.reviewCustom', 'Enter model ID…'), id: 'custom-model-id' },
		], selection.type === 'explicit' ? selection.model.model : undefined);
		if (!choice) { return; }
		const modelId = choice.id === 'custom-model-id' ? (await input.input({ title: localize('sessions.chat.permission.reviewCustomPrompt', 'Model ID supported by this connection'), value: selection.type === 'explicit' ? selection.model.model : '' }))?.trim() : choice.id;
		if (!modelId) { return; }
		const entry = catalog.find(entry => entry.model.model === modelId);
		const efforts: readonly ModelReasoningEffort[] = entry?.supportedReasoningEfforts ?? ['none', 'minimal', 'low', 'medium', 'high', 'extraHigh', 'max'];
		const effort = await selectReviewItem(input, localize('sessions.chat.permission.reviewEffort', 'Review thinking effort'), [
			{ label: localize('sessions.chat.permission.reviewEffortDefault', 'Automatic (review default)'), id: 'automatic' },
			...efforts.map(effort => ({ label: effort, id: effort })),
		], selection.type === 'explicit' ? selection.reasoningEffort : 'automatic');
		if (!effort) { return; }
		await models.setApprovalReviewModel({
			type: 'explicit', connection: connection.id, model: { provider: provider.provider, model: modelId },
			...(effort.id !== 'automatic' ? { reasoningEffort: effort.id as ModelReasoningEffort } : {}),
		});
	}
});

interface ReviewPickItem extends IQuickPickItem { readonly id: string; }

function selectReviewItem(input: IQuickInputService, title: string, items: readonly ReviewPickItem[], selectedId?: string): Promise<ReviewPickItem | undefined> {
	return new Promise(resolve => {
		const disposables = new DisposableStore();
		const picker = disposables.add(input.createQuickPick<ReviewPickItem>());
		picker.placeholder = title;
		picker.ariaLabel = title;
		picker.items = items.map(item => ({ ...item, picked: item.id === selectedId }));
		disposables.add(picker.onDidAccept(item => { resolve(item); picker.hide(); }));
		disposables.add(picker.onDidHide(() => { resolve(undefined); disposables.dispose(); }));
		picker.show();
	});
}

// ChatWidget shares these command IDs with the regular Workbench; this window owns their Sessions behavior.
registerAction2(class NewSessionsChatAction extends Action2 {
	constructor() {
		super({ id: NEW_CHAT_COMMAND_ID, title: "New Session" });
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ISessionsService).openNewSession("New code session");
	}
});

interface SessionsHistoryQuickPickItem extends IQuickPickItem {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
}

registerAction2(class ShowSessionsChatHistoryAction extends Action2 {
	constructor() {
		super({ id: SHOW_CHAT_HISTORY_COMMAND_ID, title: "Show Session History" });
	}

	override run(accessor: ServicesAccessor): void {
		const sessions = accessor.get(ISessionsManagementService);
		const view = accessor.get(ISessionsService);
		const quickPick = accessor.get(IQuickInputService).createQuickPick<SessionsHistoryQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(quickPick);
		quickPick.placeholder = "Select a session";
		quickPick.items = sessions.sessions.flatMap(session => {
			if (session.status !== "active") return [];
			const threads = session.chats.filter(thread => thread.status === "active");
			return threads.map((thread, index) => ({
				sessionId: session.sessionId,
				threadId: thread.threadId,
				label: session.title.trim() || "Session",
				description: threads.length > 1 ? `Thread ${index + 1}` : undefined,
			}));
		});
		disposables.add(quickPick.onDidAccept(item => {
			view.openSession(item.sessionId, item.threadId);
			quickPick.hide();
		}));
		disposables.add(quickPick.onDidHide(() => disposables.dispose()));
		quickPick.show();
	}
});
