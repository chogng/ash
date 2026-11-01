import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { AUDIO_PREVIEW_EDITOR_ID, VIDEO_PREVIEW_EDITOR_ID } from '../common/mediaPreview.js';
import { saveMediaFileAs } from './mediaPreviewSaveAs.js';

export type MediaPlayerKind = 'audio' | 'video';

export function isMediaPlayerKind(value: unknown): value is MediaPlayerKind {
	return value === 'audio' || value === 'video';
}

/** Identifies an audio or video resource; each pane owns its independent playback session. */
export class MediaPlayerEditorInput extends EditorInput {
	public static readonly typeId = 'workbench.input.mediaPlayer';
	public readonly typeId = MediaPlayerEditorInput.typeId;
	public override readonly editorId: string;
	public readonly readOnly = true;

	constructor(public readonly kind: MediaPlayerKind, private readonly source: IResourceEditorInput) {
		super();
		this.editorId = kind === 'audio' ? AUDIO_PREVIEW_EDITOR_ID : VIDEO_PREVIEW_EDITOR_ID;
	}

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

	public copy(): MediaPlayerEditorInput { return new MediaPlayerEditorInput(this.kind, this.source); }
	public rename(target: URI): IResourceEditorInput { return { resource: target }; }
	public async saveAs(target: URI, files: IFileService): Promise<void> { await saveMediaFileAs(this, target, files); }

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
