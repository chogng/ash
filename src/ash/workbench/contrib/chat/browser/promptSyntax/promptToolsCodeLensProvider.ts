import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import type { CodeLensList, CodeLensProvider, Command } from '../../../../../editor/common/languages.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { PromptFileParser } from '../../common/promptSyntax/promptFileParser.js';
import { getPromptFileType, PromptsType } from '../../common/promptSyntax/promptTypes.js';

const command = '_ash.prompt.selectTools';
const fields = new Set(['tools', 'requiredTools', 'disallowedTools', 'delegationTools', 'requiredDelegationTools', 'disallowedDelegationTools']);
const parser = new PromptFileParser();

function editableFields(model: ITextModel) {
	if (getPromptFileType(model.uri) !== PromptsType.agent) return [];
	const header = parser.parse(model.uri, model.getValue()).header;
	if (!header || header.errors.length) return [];
	return header.attributes.flatMap(attribute => {
		const value = attribute.value;
		if (!fields.has(attribute.key) || value.type !== 'sequence'
			|| value.items.some(item => item.type !== 'scalar' || item.missing)
			|| header.attributes.filter(other => other.key === attribute.key).length !== 1) return [];
		const names = value.items.flatMap(item => item.type === 'scalar' ? [item.value] : []);
		if (model.getValueInRange(value.range).includes('#')) return [];
		if (value.range.startLineNumber === attribute.keyRange.endLineNumber) {
			return [{ key: attribute.key, range: value.range, prefix: '', names }];
		}
		const separator = Range.fromPositions(attribute.keyRange.getEndPosition(), value.range.getStartPosition());
		if (!/^\s*:\s*$/u.test(model.getValueInRange(separator))) return [];
		return [{
			key: attribute.key,
			range: Range.fromPositions(attribute.keyRange.getEndPosition(), value.range.getEndPosition()),
			prefix: ': ',
			names,
		}];
	});
}

export class PromptToolsCodeLensProvider implements CodeLensProvider {
	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { }

	executeCodeLensCommand(model: ITextModel, action: Command, editorId: string): Promise<void> | undefined {
		if (action.id !== command || action.arguments?.[0] !== model.uri.toString()) return undefined;
		return this.instantiation.invokeFunction(selectTools, editorId, model, action.arguments[1], action.arguments[2]);
	}

	provideCodeLenses(model: ITextModel, token: CancellationToken): CodeLensList | undefined {
		if (token.isCancellationRequested) return undefined;
		return {
			lenses: editableFields(model).map(field => ({
				range: field.range,
				command: {
					id: command,
					title: localize('prompt.tools.select', 'Select Tools…'),
					arguments: [model.uri.toString(), model.getVersionId(), field.key],
				},
			}))
		};
	}
}

async function selectTools(accessor: ServicesAccessor, editorId: string, model: ITextModel, version: unknown, key: unknown): Promise<void> {
	const editors = accessor.get(ICodeEditorService);
	const quickInput = accessor.get(IQuickInputService);
	const tools = accessor.get(ILanguageModelToolsService);
	const configuration = accessor.get(IConfigurationService);
	const editor = editors.listCodeEditors().find(candidate => candidate.getId() === editorId);
	if (!editor || editor.getModel() !== model || model.getVersionId() !== version || !tools.isAvailable) return;
	const current = () => !model.isDisposed() && editor.getModel() === model && model.getVersionId() === version
		&& !editor.getOption(EditorOption.readOnly) && !configuration.getValue<boolean>(ChatAIDisabledSettingId);
	const field = editableFields(model).find(candidate => candidate.key === key);
	if (!field || !current()) return;
	await tools.refresh();
	if (!current()) return;
	const entries = new Map(field.names.map(name => [name, { label: name, description: '' }]));
	for (const tool of tools.getAllToolsIncludingDisabled()) {
		const name = tool.toolReferenceName;
		if (tool.canBeReferencedInPrompt && /^[a-zA-Z0-9_.:/-]{1,128}$/u.test(name)) {
			entries.set(name, { label: name, description: tool.displayName });
		}
	}
	using lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<{ label: string; description: string; }>());
	picker.title = picker.ariaLabel = localize('prompt.tools.selectField', 'Select Tools for {0}', field.key);
	picker.canSelectMany = true;
	picker.items = [...entries.values()];
	picker.selectedItems = field.names.map(name => entries.get(name)!);
	lifetime.add(editor.onDidChangeModel(() => picker.hide()));
	lifetime.add(editor.onDidDispose(() => picker.hide()));
	lifetime.add(model.onDidChangeContent(() => picker.hide()));
	const selected = await new Promise<readonly { label: string; }[] | undefined>(resolve => {
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		lifetime.add(picker.onDidAccept(() => {
			resolve([...picker.selectedItems]);
			picker.hide();
		}));
		picker.show();
	});
	if (!selected || !current()) return;
	const names = selected.map(item => item.label);
	if (names.length === field.names.length && names.every((name, index) => name === field.names[index])) return;
	editor.pushUndoStop();
	editor.executeEdits(command, [{ range: field.range, text: field.prefix + JSON.stringify(names) }]);
	editor.pushUndoStop();
	editor.focus();
}
