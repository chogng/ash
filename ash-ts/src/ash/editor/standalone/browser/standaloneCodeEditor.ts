import { URI } from '../../../base/common/uri.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { bindColorTheme } from '../../../platform/theme/browser/themeStyles.js';
import type { ICodeEditor } from '../../browser/editorBrowser.js';
import type { IDimension } from '../../common/core/2d/dimension.js';
import type { ICodeEditorViewState } from '../../common/editorCommon.js';
import type { ICodeEditorService } from '../../browser/services/codeEditorService.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../browser/widget/codeEditor/codeEditorWidget.js';
import type { ILanguageSelection, ILanguageService } from '../../common/languages/language.js';
import type { ITextModel } from '../../common/model.js';
import { TextModel } from '../../common/model/textModel.js';
import type { IModelService } from '../../common/services/model.js';

export interface IStandaloneCodeEditor extends ICodeEditor, IDisposable {
	getModel(): TextModel | null;
	getValue(): string;
	setValue(value: string): void;
	layout(dimension?: IDimension): void;
	saveViewState(): ICodeEditorViewState | null;
	restoreViewState(state: ICodeEditorViewState | null): void;
}

/** Standalone editor owner whose identity is shared by create(), editor events, and the editor registry. */
export class StandaloneEditor extends CodeEditorWidget implements IStandaloneCodeEditor {
	private modelToDispose: TextModel | null;

	constructor(options: CodeEditorWidgetOptions, modelToDispose: TextModel, ownsModel: boolean, themeService: Parameters<typeof bindColorTheme>[0], codeEditorService: ICodeEditorService, private readonly modelService: IModelService) {
		codeEditorService.willCreateCodeEditor();
		super(options);
		this.modelToDispose = ownsModel ? modelToDispose : null;
		try {
			this._register(bindColorTheme(themeService, options.container));
			this._register(toDisposable(() => codeEditorService.removeCodeEditor(this)));
			codeEditorService.addCodeEditor(this);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public override setModel(model: ITextModel | null): void {
		if (model !== null && (!(model instanceof TextModel) || this.modelService.getModel(model.uri) !== model)) {
			throw new ReferenceError('Standalone editor model is not registered with the model service');
		}
		const previousModel = this.getModel();
		const ownedModel = previousModel !== model && previousModel === this.modelToDispose ? this.modelToDispose : null;
		try {
			super.setModel(model);
		} finally {
			if (ownedModel && this.getModel() !== previousModel) {
				this.modelToDispose = null;
				ownedModel.dispose();
			}
		}
	}

	protected override disposeCore(): void {
		try {
			super.disposeCore();
		} finally {
			const model = this.modelToDispose;
			this.modelToDispose = null;
			model?.dispose();
		}
	}
}

/** @internal */
export function createTextModel(modelService: IModelService, languageService: ILanguageService, value: string, languageId: string | undefined, uri: URI | undefined): ITextModel {
	value ||= '';
	if (!languageId) {
		const firstLineBreak = value.indexOf('\n');
		const firstLine = firstLineBreak === -1 ? value : value.substring(0, firstLineBreak);
		return createModel(modelService, value, languageService.createByFilepathOrFirstLine(uri ?? null, firstLine), uri);
	}
	return createModel(modelService, value, languageService.createById(languageId), uri);
}

function createModel(modelService: IModelService, value: string, languageSelection: ILanguageSelection, uri: URI | undefined): ITextModel {
	return modelService.createModel(value, languageSelection, uri);
}
