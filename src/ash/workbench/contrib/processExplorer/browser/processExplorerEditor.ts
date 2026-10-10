import type { IDimension } from '../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ProcessExplorerControl } from './processExplorerControl.js';
import { ProcessExplorerEditorInput } from './processExplorerEditorInput.js';

export class ProcessExplorerEditor extends EditorPane {
	public readonly id = ProcessExplorerEditorInput.ID;
	public domNode!: HTMLElement;
	private control!: ProcessExplorerControl;

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(ProcessExplorerEditorInput.ID, theme, storage); }

	public override create(parent: HTMLElement): void {
		this.control = this._register(this.instantiation.createInstance(ProcessExplorerControl, parent));
		this.domNode = this.control.domNode;
		super.create(this.domNode);
	}
	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (input.editorId !== this.id) { throw new TypeError('Invalid process explorer input'); }
		await this.control.setInput(signal);
		signal.throwIfAborted();
	}
	public override clearInput(): void { this.control.clearInput(); }
	public override layout(dimension: IDimension): void { this.domNode.style.width = `${dimension.width}px`; this.domNode.style.height = `${dimension.height}px`; }
	public override focus(): void { this.control.focus(); }
	public override getControl(): ProcessExplorerControl { return this.control; }
}
