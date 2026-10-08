import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import * as strings from '../../../../base/common/strings.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { combinedDisposable, Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IBulkEditService } from '../../../../editor/browser/services/bulkEditService.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { trimTrailingWhitespace } from '../../../../editor/common/commands/trimTrailingWhitespaceCommand.js';
import { EditOperation } from '../../../../editor/common/core/editOperation.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, LanguageDiagnosticSeverity, type LanguageCodeActionRequest } from '../../../../editor/common/languages.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { EditSources } from '../../../../editor/common/textModelEditSource.js';
import { getCodeActions } from '../../../../editor/contrib/codeAction/browser/codeAction.js';
import { CodeActionKind } from '../../../../editor/contrib/codeAction/common/types.js';
import { SnippetController2 } from '../../../../editor/contrib/snippet/browser/snippetController2.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { SaveReason } from '../../../common/editor.js';
import { IFileTextModelService, type ITextModelSaveParticipant } from '../../../services/textmodelResolver/common/textModelResourceService.js';

const diagnosticSeverity = {
	[MarkerSeverity.Error]: LanguageDiagnosticSeverity.Error,
	[MarkerSeverity.Warning]: LanguageDiagnosticSeverity.Warning,
	[MarkerSeverity.Information]: LanguageDiagnosticSeverity.Information,
	[MarkerSeverity.Hint]: LanguageDiagnosticSeverity.Hint,
};

class TrimWhitespaceParticipant implements ITextModelSaveParticipant {
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
	) { }

	public async participate(model: TextModel, reason: SaveReason, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Save whitespace cleanup was cancelled');
		const overrides = { resource: model.uri, overrideIdentifier: model.getLanguageId() };
		if (!this.configuration.getValue<boolean>('files.trimTrailingWhitespace', overrides)) return;
		const editors = this.codeEditors.listCodeEditors().filter(editor => editor.getModel() === model);
		const protectedPositions: Position[] = [];
		if (reason === SaveReason.AUTO) {
			for (const editor of editors) {
				protectedPositions.push(...(editor.getSelections() ?? []).map(selection => selection.getPosition()));
				const snippet = SnippetController2.get(editor)?.getSessionEnclosingRange();
				if (!snippet) continue;
				// Placeholder navigation can return to any tracked line in the active session.
				for (let line = snippet.startLineNumber; line <= snippet.endLineNumber; line++) {
					protectedPositions.push(new Position(line, model.getLineMaxColumn(line)));
				}
			}
		}
		const operations = trimTrailingWhitespace(model, protectedPositions, this.configuration.getValue<boolean>('files.trimTrailingWhitespaceInRegexAndStrings', overrides));
		if (operations.length === 0) return;
		const editor = editors.find(candidate => candidate.hasTextFocus()) ?? editors[0];
		const selections = [...(editor?.getSelections() ?? [])];
		model.pushEditOperations(selections, operations, () => selections);
	}
}

class FinalNewLineParticipant implements ITextModelSaveParticipant {
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
	) { }

	public async participate(model: TextModel, _reason: SaveReason, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Save final newline insertion was cancelled');
		const overrides = { resource: model.uri, overrideIdentifier: model.getLanguageId() };
		if (!this.configuration.getValue<boolean>('files.insertFinalNewline', overrides)) return;
		const lastLine = model.getLineCount();
		if (strings.lastNonWhitespaceIndex(model.getLineContent(lastLine)) === -1) return;
		const editors = this.codeEditors.listCodeEditors().filter(editor => editor.getModel() === model);
		const editor = editors.find(candidate => candidate.hasTextFocus()) ?? editors[0];
		const selections = [...(editor?.getSelections() ?? [])];
		model.pushEditOperations(selections, [EditOperation.insert(new Position(lastLine, model.getLineMaxColumn(lastLine)), model.getEOL())], () => selections);
	}
}

class CodeActionOnSaveParticipant implements ITextModelSaveParticipant {
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILanguageFeaturesService private readonly features: ILanguageFeaturesService,
		@IBulkEditService private readonly edits: IBulkEditService,
		@IMarkerService private readonly markers: IMarkerService,
	) { }

	public async participate(model: TextModel, reason: SaveReason, signal: AbortSignal): Promise<void> {
		if (reason === SaveReason.AUTO) { return; }
		const settings = this.configuration.getValue<Readonly<Record<string, 'always' | 'explicit' | 'never'>>>('editor.codeActionsOnSave', { overrideIdentifier: model.getLanguageId() });
		const selected = Object.entries(settings)
			.filter(([, mode]) => mode === 'always' || mode === 'explicit' && reason === SaveReason.EXPLICIT)
			.map(([kind]) => new HierarchicalKind(kind));
		const kinds = selected.filter(kind => !selected.some(parent => !parent.equals(kind) && parent.contains(kind)));
		kinds.sort((left, right) => Number(CodeActionKind.SourceFixAll.contains(right)) - Number(CodeActionKind.SourceFixAll.contains(left)));
		const excludes = Object.entries(settings).filter(([, mode]) => mode === 'never').map(([kind]) => new HierarchicalKind(kind));
		const lifetime = new AbortController();
		using release = combinedDisposable(model.onWillDispose(() => lifetime.abort()), toDisposable(() => lifetime.abort()));
		const requestSignal = AbortSignal.any([signal, lifetime.signal]);
		for (const kind of kinds) {
			// Providers must query after preceding providers' edits, rather than share stale versions.
			for (const provider of this.features.codeActionProvider.ordered(model)) {
				const context = this.request(model, kind, requestSignal);
				const actions = await raceCancellationError(getCodeActions({ ordered: () => [provider] }, context, {
					include: kind, excludes, includeSourceActions: true,
				}, error => { throw error; }), requestSignal);
				assertCurrent(context);
				for (const item of actions.validActions) {
					// Each resolver receives the current model after preceding save actions have applied.
					const actionContext = this.request(model, kind, requestSignal);
					const action = (await raceCancellationError(item.resolve(actionContext), requestSignal)).action;
					assertCurrent(actionContext);
					if (!action.edit || action.disabledReason !== undefined) { continue; }
					await this.edits.apply(action.edit, {
						token: requestSignal, label: action.title, code: 'undoredo.codeActionOnSave',
						reason: EditSources.codeAction({ kind: action.kind, providerId: undefined }),
						respectAutoSaveConfig: false,
						skipSaveForResources: [model.uri],
						showPreview: false,
					});
				}
			}
		}
	}

	private request(model: TextModel, kind: HierarchicalKind, signal: AbortSignal): LanguageCodeActionRequest {
		return {
			...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
			resource: model.uri, range: model.getFullModelRange(), only: [kind.value],
			diagnostics: this.markers.read(model.uri).map(marker => ({
				range: new Range(marker.range.start.lineIndex + 1, marker.range.start.columnIndex + 1, marker.range.end.lineIndex + 1, marker.range.end.columnIndex + 1),
				severity: diagnosticSeverity[marker.severity], message: marker.message, source: marker.source, code: marker.code,
			})),
		};
	}
}

function assertCurrent(request: LanguageCodeActionRequest): void {
	if (!isLanguageFeatureRequestCurrent(request)) {
		throw new CancellationError(localize('codeActions.save.changed', 'The code changed while preparing to save. Save again to run code actions on the latest text.'));
	}
}

/** One window registration; the shared file model service owns save ordering and persistence. */
export class SaveParticipantsContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.saveParticipants';

	constructor(
		@IFileTextModelService models: IFileTextModelService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this._register(models.addSaveParticipant(instantiation.createInstance(TrimWhitespaceParticipant)));
		this._register(models.addSaveParticipant(instantiation.createInstance(CodeActionOnSaveParticipant)));
		this._register(models.addSaveParticipant(instantiation.createInstance(FinalNewLineParticipant)));
	}
}
