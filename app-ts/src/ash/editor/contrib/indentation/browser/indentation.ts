import * as nls from '../../../../nls.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type IActionOptions, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../../../common/editorCommon.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { type ITextModel } from '../../../common/model.js';
import { getReindentEditOperations } from '../common/indentation.js';
import { generateIndent, getSpaceCnt } from '../common/indentUtils.js';

abstract class ConvertIndentationAction extends EditorAction {
	constructor(private readonly insertSpaces: boolean, options: IActionOptions) {
		super(options);
	}

	run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		const selection = editor.getSelection();
		if (!model || !selection) return;
		const tabSize = model.getOptions().tabSize;
		const command = this.insertSpaces
			? new IndentationToSpacesCommand(selection, tabSize)
			: new IndentationToTabsCommand(selection, tabSize);
		editor.executeCommand(this.id, command);
		model.updateOptions({ insertSpaces: this.insertSpaces });
	}
}

export class IndentationToSpacesAction extends ConvertIndentationAction {
	static readonly ID = 'editor.action.indentationToSpaces';
	constructor() {
		super(true, { id: IndentationToSpacesAction.ID, label: nls.localize2('indentationToSpaces', 'Convert Indentation to Spaces'), precondition: undefined });
	}
}

export class IndentationToTabsAction extends ConvertIndentationAction {
	static readonly ID = 'editor.action.indentationToTabs';
	constructor() {
		super(false, { id: IndentationToTabsAction.ID, label: nls.localize2('indentationToTabs', 'Convert Indentation to Tabs'), precondition: undefined });
	}
}

export class ChangeIndentationSizeAction extends EditorAction {
	constructor(
		private readonly insertSpaces: boolean,
		private readonly displaySizeOnly: boolean,
		options: IActionOptions,
	) {
		super(options);
	}

	run(_accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): void {
		const model = editor.getModel();
		if (!model) return;
		const current = model.getOptions();
		const tabSize = readTabSize(args, current.tabSize);
		model.updateOptions(this.displaySizeOnly
			? { tabSize }
			: { tabSize, indentSize: tabSize, insertSpaces: this.insertSpaces });
	}
}

export class IndentUsingTabs extends ChangeIndentationSizeAction {
	static readonly ID = 'editor.action.indentUsingTabs';
	constructor() {
		super(false, false, { id: IndentUsingTabs.ID, label: nls.localize2('indentUsingTabs', 'Indent Using Tabs'), precondition: undefined });
	}
}

export class IndentUsingSpaces extends ChangeIndentationSizeAction {
	static readonly ID = 'editor.action.indentUsingSpaces';
	constructor() {
		super(true, false, { id: IndentUsingSpaces.ID, label: nls.localize2('indentUsingSpaces', 'Indent Using Spaces'), precondition: undefined });
	}
}

export class ChangeTabDisplaySize extends ChangeIndentationSizeAction {
	static readonly ID = 'editor.action.changeTabDisplaySize';
	constructor() {
		super(true, true, { id: ChangeTabDisplaySize.ID, label: nls.localize2('changeTabDisplaySize', 'Change Tab Display Size'), precondition: undefined });
	}
}

export class DetectIndentation extends EditorAction {
	static readonly ID = 'editor.action.detectIndentation';
	constructor() {
		super({ id: DetectIndentation.ID, label: nls.localize2('detectIndentation', 'Detect Indentation from Content'), precondition: undefined });
	}

	run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		if (!model) return;
		const options = model.getOptions();
		model.detectIndentation(options.insertSpaces, options.tabSize);
	}
}

abstract class ReindentAction extends EditorAction {
	constructor(private readonly selectedOnly: boolean, options: IActionOptions) {
		super(options);
	}

	run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		const selection = editor.getSelection();
		if (!model || !selection) return;
		const start = this.selectedOnly ? selection.startLineNumber : 1;
		const end = this.selectedOnly ? selection.endLineNumber : model.getLineCount();
		const edits = getReindentEditOperations(model, accessor.get(ILanguageConfigurationService), start, end);
		if (edits.length === 0) return;
		editor.executeCommand(this.id, new ReindentCommand(selection, edits));
	}
}

export class ReindentLinesAction extends ReindentAction {
	constructor() {
		super(false, { id: 'editor.action.reindentlines', label: nls.localize2('reindentLines', 'Reindent Lines'), precondition: undefined });
	}
}

export class ReindentSelectedLinesAction extends ReindentAction {
	constructor() {
		super(true, { id: 'editor.action.reindentselectedlines', label: nls.localize2('reindentSelectedLines', 'Reindent Selected Lines'), precondition: undefined });
	}
}

export class IndentationToSpacesCommand implements ICommand {
	private selectionId: string | undefined;
	constructor(private readonly selection: Selection, private readonly tabSize: number) {}
	getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		this.selectionId = builder.trackSelection(this.selection);
		addIndentationEdits(model, builder, this.tabSize, true);
	}
	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(requiredSelectionId(this.selectionId));
	}
}

export class IndentationToTabsCommand implements ICommand {
	private selectionId: string | undefined;
	constructor(private readonly selection: Selection, private readonly tabSize: number) {}
	getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		this.selectionId = builder.trackSelection(this.selection);
		addIndentationEdits(model, builder, this.tabSize, false);
	}
	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(requiredSelectionId(this.selectionId));
	}
}

class ReindentCommand implements ICommand {
	private selectionId: string | undefined;
	constructor(private readonly selection: Selection, private readonly edits: readonly { readonly range: import('../../../common/core/range.js').IRange; readonly text: string | null }[]) {}
	getEditOperations(_model: ITextModel, builder: IEditOperationBuilder): void {
		this.selectionId = builder.trackSelection(this.selection);
		for (const edit of this.edits) builder.addEditOperation(edit.range, edit.text);
	}
	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(requiredSelectionId(this.selectionId));
	}
}

function addIndentationEdits(model: ITextModel, builder: IEditOperationBuilder, tabSize: number, insertSpaces: boolean): void {
	for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
		const content = model.getLineContent(lineNumber);
		const indentation = /^[\t ]*/.exec(content)![0];
		const normalized = generateIndent(getSpaceCnt(indentation, tabSize), tabSize, insertSpaces);
		if (normalized !== indentation) builder.addEditOperation(new Range(lineNumber, 1, lineNumber, indentation.length + 1), normalized);
	}
}

function readTabSize(args: unknown, fallback: number): number {
	const value = typeof args === 'number' ? args : typeof args === 'object' && args !== null && 'tabSize' in args ? (args as { tabSize?: unknown }).tabSize : fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 32) throw new RangeError('Tab size must be an integer from 1 to 32');
	return value as number;
}

function requiredSelectionId(value: string | undefined): string {
	if (!value) throw new Error('Indentation command has not collected its selection');
	return value;
}

registerEditorAction(IndentationToSpacesAction);
registerEditorAction(IndentationToTabsAction);
registerEditorAction(IndentUsingTabs);
registerEditorAction(IndentUsingSpaces);
registerEditorAction(ChangeTabDisplaySize);
registerEditorAction(DetectIndentation);
registerEditorAction(ReindentLinesAction);
registerEditorAction(ReindentSelectedLinesAction);
