import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { PromptFileParser } from '../../common/promptSyntax/promptFileParser.js';
import { getPromptFileType, PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { PromptValidator } from '../../common/promptSyntax/languageProviders/promptValidator.js';
import { askForPromptFileName } from './pickers/askForPromptName.js';
import { askForPromptSourceFolder } from './pickers/askForPromptSourceFolder.js';

export const NEW_AGENT_COMMAND_ID = 'workbench.command.new.agent';
export const NEW_INSTRUCTIONS_COMMAND_ID = 'workbench.command.new.instructions';

async function createDefinition(accessor: ServicesAccessor, type: PromptsType.agent | PromptsType.instructions, fromEditor = false): Promise<void> {
	const configuration = accessor.get(IConfigurationService);
	if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) { return; }
	const workspace = accessor.get(IWorkspaceContextService);
	const remote = accessor.get(IAppServerRemoteAgentService);
	const files = accessor.get(IFileService);
	const editors = accessor.get(IEditorService);
	const dialogs = accessor.get(IDialogService);
	const quickInput = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const sourceEditor = fromEditor ? accessor.get(ICodeEditorService).getActiveCodeEditor() : undefined;
	const source = sourceEditor?.getModel();
	if (fromEditor && (!source || source.getLanguageId() !== 'markdown' || getPromptFileType(source.uri) || !source.getValue().trim())) {
		notifications.info(localize('prompt.saveAs.source', 'Open a Markdown document with the instructions you want to save.'));
		return;
	}
	const bodySnapshot = source?.getValue();
	const sourceVersion = source?.getVersionId();
	const snapshot = workspace.getWorkspace();
	const connection = remote.connection;
	const assertCurrent = (): void => {
		if (snapshot !== workspace.getWorkspace() || connection !== remote.connection || configuration.getValue<boolean>(ChatAIDisabledSettingId)
			|| source && (source.isDisposed() || sourceEditor?.getModel() !== source || source.getVersionId() !== sourceVersion)) {
			throw new CancellationError();
		}
	};
	const folder = await askForPromptSourceFolder(snapshot.folders, quickInput, notifications);
	if (!folder) { return; }
	assertCurrent();
	const name = await askForPromptFileName(quickInput);
	if (!name) { return; }
	assertCurrent();
	const result = await dialogs.input({
		title: type === PromptsType.agent ? localize('prompt.create.agent', 'New Agent file') : localize('prompt.create.instructions', 'New Instructions file'),
		message: fromEditor ? localize('prompt.saveAs.content', 'Save a copy of the current Markdown as a definition. Agent definitions require a description.') : localize('prompt.create.content', 'Enter the instructions. Agent definitions also require a description. New Instructions use on-demand loading.'),
		inputs: [
			{ placeholder: localize('prompt.create.description', 'Description') },
			...(fromEditor ? [] : [{ placeholder: localize('prompt.create.body', 'Instructions') }]),
		],
		primaryButton: localize('prompt.create.button', 'Create'),
	});
	if (!result.confirmed) { return; }
	assertCurrent();
	const description = result.values?.[0]?.trim() ?? '';
	const body = bodySnapshot ?? result.values?.[1] ?? '';
	const resource = URI.joinPath(folder, '.ash', type === PromptsType.agent ? 'agents' : 'instructions', `${name}.md`);
	const header = [`name: ${JSON.stringify(name)}`];
	if (description || type === PromptsType.agent) { header.push(`description: ${JSON.stringify(description)}`); }
	if (type === PromptsType.instructions) { header.push('load: on-demand'); }
	const content = `---\n${header.join('\n')}\n---\n\n${body}\n`;
	const diagnostics = new PromptValidator().validate(new PromptFileParser().parse(resource, content));
	if (diagnostics.length) { throw new Error(diagnostics.map(diagnostic => diagnostic.message).join('\n')); }
	await files.createDirectory(dirname(resource));
	assertCurrent();
	// The provider checks nonexistence atomically; a competing creator never causes overwrite.
	await files.writeFileBytes(resource, new TextEncoder().encode(content), { create: true, overwrite: false });
	assertCurrent();
	await editors.openEditor({ resource, languageId: 'markdown' }, { pinned: true });
}

export function registerNewPromptFileActions(): DisposableStore {
	const registrations = new DisposableStore();
	for (const definition of [
		{ id: NEW_AGENT_COMMAND_ID, fromEditor: false, type: PromptsType.agent, title: localize2('prompt.create.agentCommand', 'Chat: New Agent File…') },
		{ id: NEW_INSTRUCTIONS_COMMAND_ID, fromEditor: false, type: PromptsType.instructions, title: localize2('prompt.create.instructionsCommand', 'Chat: New Instructions File…') },
		{ id: 'workbench.action.chat.saveAsAgent', fromEditor: true, type: PromptsType.agent, title: localize2('prompt.saveAs.agent', 'Chat: Save Current Markdown as Agent…') },
		{ id: 'workbench.action.chat.saveAsInstructions', fromEditor: true, type: PromptsType.instructions, title: localize2('prompt.saveAs.instructions', 'Chat: Save Current Markdown as Instructions…') },
	] as const) {
		registrations.add(registerAction2(class extends Action2 {
			constructor() { super({ id: definition.id, title: definition.title, f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) }); }
			public override run(accessor: ServicesAccessor): Promise<void> { return createDefinition(accessor, definition.type, definition.fromEditor); }
		}));
	}
	return registrations;
}
