import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IMAGE_PREVIEW_EDITOR_ID } from '../common/mediaPreview.js';
import { saveMediaFileAs } from './mediaPreviewSaveAs.js';

/** Resource identity for an image tab. The pane owns decoding, URLs and view state. */
export class ImagePreviewEditorInput extends EditorInput {
	public static readonly ID = 'workbench.input.imagePreview';
	public readonly typeId = ImagePreviewEditorInput.ID;
	public override readonly editorId = IMAGE_PREVIEW_EDITOR_ID;
	public readonly readOnly = true;

	constructor(private readonly source: IResourceEditorInput) { super(); }

	public get resource(): URI { return this.source.resource; }
	public get preferredResource(): URI | undefined { return this.source.preferredResource; }
	public get contentType(): string | undefined { return this.source.contentType; }
	public get languageId(): string | undefined { return this.source.languageId; }
	public get initialBytes(): Uint8Array | undefined { return this.source.initialBytes; }
	public get encoding(): string | undefined { return this.source.encoding; }
	public get capabilities(): IResourceEditorInput['capabilities'] { return this.source.capabilities; }
	public get closeHandler(): IResourceEditorInput['closeHandler'] { return this.source.closeHandler; }
	public get showBreadcrumbs(): boolean | undefined { return this.source.showBreadcrumbs; }
	public get onDidChangeLabel(): IResourceEditorInput['onDidChangeLabel'] { return this.source.onDidChangeLabel; }
	public getName(): string { return this.source.label ?? basename(this.preferredResource ?? this.resource); }
	public getIcon(): ReturnType<NonNullable<IResourceEditorInput['getIcon']>> { return this.source.getIcon?.(); }
	public canMove(sourceGroup: number, targetGroup: number): true | string { return this.source.canMove?.(sourceGroup, targetGroup) ?? true; }

	public copy(): ImagePreviewEditorInput { return new ImagePreviewEditorInput(this.source); }

	/** Resolve the destination afresh: a new extension can require a different editor. */
	public rename(target: URI): IResourceEditorInput { return { resource: target }; }

	public async saveAs(target: URI, files: IFileService): Promise<void> {
		await saveMediaFileAs(this, target, files);
	}

	/** Drop the preview identity and its view-only restriction when choosing another editor. */
	public toUntyped(): IResourceEditorInput {
		return {
			resource: this.resource, preferredResource: this.preferredResource,
			contentType: this.contentType, languageId: this.languageId, label: this.source.label,
			initialBytes: this.initialBytes, initialText: this.source.initialText,
			readOnly: this.source.readOnly, encoding: this.encoding, showBreadcrumbs: this.showBreadcrumbs,
			capabilities: this.capabilities, closeHandler: this.closeHandler, onDidChangeLabel: this.onDidChangeLabel,
			getIcon: this.source.getIcon?.bind(this.source), canMove: this.source.canMove?.bind(this.source),
		};
	}
}
