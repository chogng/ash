import type { EditorInput } from '../../../services/editor/common/editorService.js';

/** An independently opened custom view shares the source URI but has its own tab identity. */
export class CustomEditorInput implements EditorInput {
	public static readonly ID = 'workbench.editors.customEditorInput';
	constructor(private readonly source: EditorInput, public readonly editorId: string) { }
	public get resource(): EditorInput['resource'] { return this.source.resource; }
	public get languageId(): string | undefined { return this.source.languageId; }
	public get contentType(): string | undefined { return this.source.contentType; }
	public get initialText(): string | undefined { return this.source.initialText; }
	public get readOnly(): boolean | undefined { return this.source.readOnly; }
	public get capabilities(): EditorInput['capabilities'] { return this.source.capabilities; }
	public get showBreadcrumbs(): boolean | undefined { return this.source.showBreadcrumbs; }
	public getIcon(): ReturnType<NonNullable<EditorInput['getIcon']>> { return this.source.getIcon?.(); }
	public get label(): string | undefined { return this.source.label; }
	public get onDidChangeLabel(): EditorInput['onDidChangeLabel'] { return this.source.onDidChangeLabel; }
	public toUntyped(): EditorInput { return this.source; }
}
