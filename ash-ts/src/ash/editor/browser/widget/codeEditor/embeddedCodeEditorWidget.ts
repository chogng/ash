import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { ICodeEditor } from '../../editorBrowser.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from './codeEditorWidget.js';
import { ConfigurationChangedEvent, IEditorOptions } from '../../../common/config/editorOptions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

export class EmbeddedCodeEditorWidget extends CodeEditorWidget {
	private readonly overwriteOptions: IEditorOptions;

	constructor(
		domElement: HTMLElement,
		options: IEditorOptions,
		codeEditorWidgetOptions: ICodeEditorWidgetOptions,
		private readonly parentEditor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@ILanguageConfigurationService languageConfigurationService: ILanguageConfigurationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
	) {
		super({
			...parentEditor.getRawOptions(),
			...codeEditorWidgetOptions,
			...options,
			container: domElement,
		}, instantiationService, themeService, languageConfigurationService, languageFeaturesService);

		this.overwriteOptions = { ...options };
		super.updateOptions(this.overwriteOptions);
		this._register(parentEditor.onDidChangeConfiguration((event: ConfigurationChangedEvent) => this.onParentConfigurationChanged(event)));
	}

	getParentEditor(): ICodeEditor {
		return this.parentEditor;
	}

	private onParentConfigurationChanged(_event: ConfigurationChangedEvent): void {
		super.updateOptions({ ...this.parentEditor.getRawOptions(), ...this.overwriteOptions });
	}

	override updateOptions(newOptions: IEditorOptions): void {
		Object.assign(this.overwriteOptions, newOptions);
		super.updateOptions(this.overwriteOptions);
	}
}

export function getOuterEditor(accessor: ServicesAccessor): ICodeEditor | null {
	const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
	return editor instanceof EmbeddedCodeEditorWidget ? editor.getParentEditor() : editor;
}
