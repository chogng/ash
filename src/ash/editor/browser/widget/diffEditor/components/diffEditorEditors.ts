import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IDiffEditorOptions } from '../../../../common/config/editorOptions.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../codeEditor/codeEditorWidget.js';
import type { DiffEditorWidgetOptions } from '../diffEditorOptions.js';

/** Owns the editor pair; the comparison's text models remain caller-owned. */
export class DiffEditorEditors extends Disposable {
	public readonly original: CodeEditorWidget;
	public readonly modified: CodeEditorWidget;
	private codeLens: boolean;

	constructor(
		originalContainer: HTMLElement,
		modifiedContainer: HTMLElement,
		options: DiffEditorWidgetOptions,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.codeLens = options.diffCodeLens ?? false;
		const shared: CodeEditorWidgetOptions = {
			...options,
			container: originalContainer,
			model: options.model.original,
			isSimpleWidget: false,
			inDiffEditor: true,
			folding: false,
			fixedOverflowWidgets: true,
			minimap: { enabled: false },
			codeLens: this.codeLens,
			lineNumbers: options.showLineNumbers === false ? 'off' : options.lineNumbers ?? 'on',
			wordWrap: options.wordWrap ?? 'off',
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
			glyphMargin: options.glyphMargin,
		}));
	}

	public getContentHeight(): number {
		return Math.max(this.original.getContentHeight(), this.modified.getContentHeight());
	}

	public updateOptions(options: IDiffEditorOptions): void {
		this.codeLens = options.diffCodeLens ?? this.codeLens;
		const shared = { ...options, folding: false, fixedOverflowWidgets: true, minimap: { ...options.minimap, enabled: false }, codeLens: this.codeLens };
		this.original.updateOptions({ ...shared, readOnly: true });
		this.modified.updateOptions(shared);
	}
}
