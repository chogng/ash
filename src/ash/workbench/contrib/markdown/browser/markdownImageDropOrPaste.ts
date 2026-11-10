import { VSBuffer } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IReadonlyVSDataTransfer } from '../../../../base/common/dataTransfer.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getExtensionForMimeType } from '../../../../base/common/mime.js';
import { posix } from '../../../../base/common/path.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { IPosition } from '../../../../editor/common/core/position.js';
import type { IRange } from '../../../../editor/common/core/range.js';
import type { DocumentDropEditProvider, DocumentPasteContext, DocumentPasteEdit, DocumentPasteEditProvider, WorkspaceEditEntry } from '../../../../editor/common/languages.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';

const imageKind = new HierarchicalKind('markdown.link.image');

/** Markdown's file editor inserts a relative reference and its asset in the same workspace edit. */
export class MarkdownImageDropOrPaste extends Disposable implements DocumentPasteEditProvider, DocumentDropEditProvider {
	readonly id = 'markdown.image';
	readonly copyMimeTypes = [];
	readonly pasteMimeTypes = ['image/*'];
	readonly dropMimeTypes = this.pasteMimeTypes;
	readonly providedPasteEditKinds = [imageKind];
	readonly providedDropEditKinds = this.providedPasteEditKinds;

	constructor(
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@IFileService private readonly files: IFileService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		const selector = { language: 'markdown', hasAccessToAllModels: true };
		this._register(features.documentPasteEditProvider.register(selector, this));
		this._register(features.documentDropEditProvider.register(selector, this));
	}

	async provideDocumentPasteEdits(model: ITextModel, _ranges: readonly IRange[], transfer: IReadonlyVSDataTransfer, context: DocumentPasteContext, token: CancellationToken) {
		if (context.only && !context.only.contains(imageKind)) return undefined;
		return this.createEdit(model, transfer, token);
	}

	async provideDocumentDropEdits(model: ITextModel, _position: IPosition, transfer: IReadonlyVSDataTransfer, token: CancellationToken) {
		return this.createEdit(model, transfer, token);
	}

	private async createEdit(model: ITextModel, transfer: IReadonlyVSDataTransfer, token: CancellationToken) {
		const resource = model.uri;
		if (resource.scheme === 'untitled' || !this.files.hasCapability(resource, FileSystemProviderCapabilities.FileReadWrite)
			|| this.files.hasCapability(resource, FileSystemProviderCapabilities.Readonly)) return undefined;
		const parent = dirname(resource);
		const extUri = this.uriIdentity.extUri;
		const folder = this.workspace.getWorkspaceFolder(resource);
		const alt = localize('markdown.image.altText', 'alt text').replace(/[\[\]\\]/g, '\\$&');
		const placeholder = alt.replace(/[\\$}]/g, '\\$&');
		const edits: WorkspaceEditEntry[] = [];
		const links: string[] = [];
		let names: Set<string> | undefined;
		for (const [mime, item] of transfer) {
			const extension = mime.startsWith('image/') && getExtensionForMimeType(mime);
			const file = extension && item.asFile();
			if (!file || !extension) continue;
			let path = file.uri && folder && extUri.isEqual(folder.uri, this.workspace.getWorkspaceFolder(file.uri)?.uri)
				? posix.relative(parent.toEncodedComponents().path, file.uri.toEncodedComponents().path) : undefined;
			if (!path) {
				names ??= new Set((await this.files.readDirectory(parent)).map(entry => entry.name.toLowerCase()));
				if (token.isCancellationRequested) return undefined;
				const stem = imageFileStem(file.name);
				let name = `${stem}${extension}`;
				for (let suffix = 1; names.has(name.toLowerCase()); suffix++) name = `${stem}-${suffix}${extension}`;
				names.add(name.toLowerCase());
				const bytes = await file.data();
				if (token.isCancellationRequested) return undefined;
				if (!bytes.length) continue;
				path = encodeURIComponent(name);
				edits.push({ newResource: URI.joinPath(parent, name), options: { contents: Promise.resolve(VSBuffer.wrap(new Uint8Array(bytes))) } });
			}
			const destination = path.replaceAll('(', '%28').replaceAll(')', '%29');
			links.push(`![\${${links.length + 1}:${placeholder}}](${destination})`);
		}
		if (!links.length || token.isCancellationRequested) return undefined;
		const edit: DocumentPasteEdit = {
			title: localize('markdown.image.insert', 'Insert Markdown Image'), kind: imageKind,
			insertText: { snippet: links.join(' ') }, additionalEdit: { edits },
		};
		return { edits: [edit], dispose() { } };
	}
}

function imageFileStem(name: string): string {
	const base = name.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '');
	const stem = /^.{1,80}/u.exec(base.replace(/[^\p{L}\p{N} _-]/gu, '-').trim())?.[0] ?? 'image';
	return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `image-${stem}` : stem;
}
