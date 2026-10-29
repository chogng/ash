import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { EditorOption, RenderLineNumbersType, type IDiffEditorOptions } from '../../../common/config/editorOptions.js';
import type { ICodeEditor } from '../../editorBrowser.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import type { DiffEditorWidgetOptions } from './diffEditorOptions.js';
import { DiffEditorWidget } from './diffEditorWidget.js';

type EmbeddedOptions = IDiffEditorOptions & Pick<DiffEditorWidgetOptions, 'showInlineChanges' | 'loopChanges'>;

/** Inherits live parent presentation while retaining the embedded view's explicit options. */
export class EmbeddedDiffEditorWidget extends DiffEditorWidget {
	private overrides: EmbeddedOptions;

	constructor(
		options: DiffEditorWidgetOptions,
		parentEditor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibilitySignalService signals: IAccessibilitySignalService,
	) {
		const inherited = parentPresentation(parentEditor);
		super(
			{
				...inherited,
				fontLigatures: inherited.fontLigatures === true,
				showLineNumbers: inherited.lineNumbers !== 'off',
				...options,
			},
			instantiationService,
			codeEditorService,
			configuration,
			signals,
		);
		const { container: _container, model: _model, wordWrap: _wordWrap, showLineNumbers, ...overrides } = options;
		this.overrides = {
			...overrides,
			...(showLineNumbers === undefined ? {} : { lineNumbers: showLineNumbers ? 'on' : 'off' }),
		};
		this._register(
			parentEditor.onDidChangeConfiguration(() => {
				super.updateOptions({ ...parentPresentation(parentEditor), ...this.overrides });
			}),
		);
	}

	public override updateOptions(options: EmbeddedOptions): void {
		this.overrides = { ...this.overrides, ...options };
		super.updateOptions(this.overrides);
	}
}

function parentPresentation(
	editor: ICodeEditor,
): Pick<DiffEditorWidgetOptions, 'lineHeight' | 'fontFamily' | 'fontSize' | 'fontLigatures'> & {
	lineNumbers: 'on' | 'off';
} {
	const font = editor.getOption(EditorOption.fontInfo);
	return {
		lineHeight: font.lineHeight,
		fontFamily: font.fontFamily,
		fontSize: font.fontSize,
		fontLigatures: editor.getRawOptions().fontLigatures === true,
		lineNumbers: editor.getOption(EditorOption.lineNumbers).renderType === RenderLineNumbersType.Off ? 'off' : 'on',
	};
}
