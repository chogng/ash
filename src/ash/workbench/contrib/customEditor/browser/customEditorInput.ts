import type { IResourceEditorInput } from '../../../common/editor.js';
import { basename } from '../../../../base/common/resources.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** An independently opened custom view shares the source URI but has its own tab identity. */
export class CustomEditorInput extends EditorInput {
	public static readonly ID = 'workbench.editors.customEditorInput';
	public readonly typeId = CustomEditorInput.ID;
	constructor(private readonly source: IResourceEditorInput, public override readonly editorId: string) { super(); }
	public get resource(): IResourceEditorInput['resource'] { return this.source.resource; }
	public get languageId(): string | undefined { return this.source.languageId; }
	public get contentType(): string | undefined { return this.source.contentType; }
	public get initialText(): string | undefined { return this.source.initialText; }
	public get readOnly(): boolean | undefined { return this.source.readOnly; }
	public get capabilities(): IResourceEditorInput['capabilities'] { return this.source.capabilities; }
	public get showBreadcrumbs(): boolean | undefined { return this.source.showBreadcrumbs; }
	public getIcon(): ReturnType<NonNullable<IResourceEditorInput['getIcon']>> { return this.source.getIcon?.(); }
	public getName(): string { return this.source.label ?? basename(this.resource); }
	public get onDidChangeLabel(): IResourceEditorInput['onDidChangeLabel'] { return this.source.onDidChangeLabel; }
	public toUntyped(): IResourceEditorInput { return this.source; }
}
