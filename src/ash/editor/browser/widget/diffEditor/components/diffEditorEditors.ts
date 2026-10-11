import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IEditorOptions } from '../../../../common/config/editorOptions.js';
import { EditorExtensionsRegistry } from '../../../editorExtensions.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../codeEditor/codeEditorWidget.js';
import type { DiffEditorWidgetOptions } from '../diffEditorOptions.js';

/** Owns the editor pair; the comparison's text models remain caller-owned. */
export class DiffEditorEditors extends Disposable {
	public readonly original: CodeEditorWidget;
	public readonly modified: CodeEditorWidget;

	constructor(
		originalContainer: HTMLElement,
		modifiedContainer: HTMLElement,
		options: DiffEditorWidgetOptions,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const shared: Pick<CodeEditorWidgetOptions, 'contributions' | 'isSimpleWidget' | 'minimap' | 'lineHeight' | 'fontFamily' | 'fontSize' | 'fontLigatures' | 'lineNumbers' | 'wordWrap' | 'scrollBeyondLastLine'> = {
			// Diff owns its comparison UI; line navigation uses the shared editor controller.
			contributions: EditorExtensionsRegistry.getEditorContributions().filter(contribution => contribution.id === 'editor.contrib.quickAccess'),
			isSimpleWidget: true,
			minimap: { enabled: false },
			lineHeight: options.lineHeight,
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			lineNumbers: options.showLineNumbers === false ? 'off' : 'on',
			wordWrap: options.wordWrap ? 'on' : 'off',
			scrollBeyondLastLine: options.scrollBeyondLastLine ?? true,
		};
		this.original = this._register(instantiationService.createInstance(CodeEditorWidget, {
			...shared,
			container: originalContainer,
			model: options.model.original,
			ariaLabel: options.originalAriaLabel,
			readOnly: true,
		}));
		this.modified = this._register(instantiationService.createInstance(CodeEditorWidget, {
			...shared,
			container: modifiedContainer,
			model: options.model.modified,
			ariaLabel: options.modifiedAriaLabel,
			readOnly: options.readOnly ?? false,
			glyphMargin: options.renderMarginRevertIcon && !options.readOnly,
		}));
	}

	public getContentHeight(): number {
		return Math.max(this.original.getContentHeight(), this.modified.getContentHeight());
	}

	public updateOptions(options: IEditorOptions): void {
		this.original.updateOptions({ ...options, readOnly: true });
		this.modified.updateOptions(options);
	}
}
