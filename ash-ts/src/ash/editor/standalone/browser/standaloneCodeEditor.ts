import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { URI } from '../../../base/common/uri.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { bindColorTheme } from '../../../platform/theme/browser/themeStyles.js';
import type { ICodeEditor } from '../../browser/editorBrowser.js';
import type { IDimension } from '../../common/core/2d/dimension.js';
import type { ICodeEditorViewState } from '../../common/editorCommon.js';
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../browser/widget/codeEditor/codeEditorWidget.js';
import type { ILanguageSelection, ILanguageService } from '../../common/languages/language.js';
import type { ITextModel } from '../../common/model.js';
import { TextModel } from '../../common/model/textModel.js';
import { IModelService } from '../../common/services/model.js';
import type { IEditorOptions } from '../../common/config/editorOptions.js';
import { IStandaloneThemeService } from '../common/standaloneTheme.js';

type StandaloneCodeEditorOptions = Omit<CodeEditorWidgetOptions,
	'container' | 'input' | 'languageId' | 'model' |
	'editorWorkerFactory' | 'completionWorkerFactory' | 'codeEditorService' |
	'registerBeforeSave' | 'formatOnSave'
>;

export interface IStandaloneEditorConstructionOptions extends StandaloneCodeEditorOptions {
	readonly model?: ITextModel | null;
	readonly value?: string;
	readonly language?: string;
	readonly resource?: URI;
	readonly label?: string;
	readonly readOnly?: boolean;
	readonly theme?: string;
	readonly autoDetectHighContrast?: boolean;
}

export interface IStandaloneCodeEditor extends ICodeEditor, IDisposable {
	updateOptions(newOptions: Readonly<IEditorOptions & Pick<IStandaloneEditorConstructionOptions, 'theme' | 'autoDetectHighContrast'>>): void;
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
	private readonly modelService: IModelService;
	private readonly standaloneThemeService: IStandaloneThemeService;

	constructor(
		options: CodeEditorWidgetOptions,
		modelToDispose: TextModel | null,
		ownsModel: boolean,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStandaloneThemeService standaloneThemeService: IStandaloneThemeService,
		@ILanguageConfigurationService languageConfigurationService: ILanguageConfigurationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IModelService modelService: IModelService,
	) {
		codeEditorService.willCreateCodeEditor();
		// Theme variables must be ready before the view handles a theme event.
		const themeBinding = bindColorTheme(standaloneThemeService, options.container);
		try {
			super(options, instantiationService, standaloneThemeService, languageConfigurationService, languageFeaturesService, contextKeyService);
		} catch (error) {
			themeBinding.dispose();
			throw error;
		}
		this._register(themeBinding);
		this.standaloneThemeService = standaloneThemeService;
		this.modelService = modelService;
		this.modelToDispose = ownsModel ? modelToDispose : null;
		try {
			this._register(toDisposable(() => codeEditorService.removeCodeEditor(this)));
			codeEditorService.addCodeEditor(this);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public override updateOptions(newOptions: Readonly<IEditorOptions & Pick<IStandaloneEditorConstructionOptions, 'theme' | 'autoDetectHighContrast'>>): void {
		this.assertNotDisposed();
		if (newOptions.theme !== undefined) {
			this.standaloneThemeService.setTheme(newOptions.theme);
		}
		if (newOptions.autoDetectHighContrast !== undefined) {
			this.standaloneThemeService.setAutoDetectHighContrast(newOptions.autoDetectHighContrast);
		}
		super.updateOptions(newOptions);
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
