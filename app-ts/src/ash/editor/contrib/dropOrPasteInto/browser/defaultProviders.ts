import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { type IReadonlyVSDataTransfer, UriList } from '../../../../base/common/dataTransfer.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Mimes } from '../../../../base/common/mime.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { type IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { type IPosition } from '../../../common/core/position.js';
import { type IRange } from '../../../common/core/range.js';
import {
	DocumentPasteTriggerKind,
	type DocumentDropEdit,
	type DocumentDropEditProvider,
	type DocumentDropEditsSession,
	type DocumentPasteContext,
	type DocumentPasteEdit,
	type DocumentPasteEditProvider,
	type DocumentPasteEditsSession,
} from '../../../common/languages.js';
import { type ITextModel } from '../../../common/model.js';
import { type ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';

const allModels = { scheme: '*', hasAccessToAllModels: true } as const;
const textKind = HierarchicalKind.Empty.append('text', 'plain');
const absolutePathKind = HierarchicalKind.Empty.append('uri', 'path', 'absolute');
const relativePathKind = HierarchicalKind.Empty.append('uri', 'path', 'relative');
const htmlKind = HierarchicalKind.Empty.append('html');

type TransferEdit = Pick<DocumentPasteEdit, 'title' | 'kind' | 'insertText' | 'handledMimeType' | 'yieldTo'>;

abstract class TransferProvider implements DocumentPasteEditProvider, DocumentDropEditProvider {
	readonly copyMimeTypes: readonly string[] = [];
	readonly providedPasteEditKinds: readonly HierarchicalKind[];
	readonly providedDropEditKinds: readonly HierarchicalKind[];
	abstract readonly pasteMimeTypes: readonly string[];
	abstract readonly dropMimeTypes: readonly string[];

	constructor(readonly kind: HierarchicalKind) {
		this.providedPasteEditKinds = [kind];
		this.providedDropEditKinds = [kind];
	}

	async provideDocumentPasteEdits(
		_model: ITextModel,
		_ranges: readonly IRange[],
		transfer: IReadonlyVSDataTransfer,
		_context: DocumentPasteContext,
		token: CancellationToken,
	): Promise<DocumentPasteEditsSession | undefined> {
		const edit = await this.getEdit(transfer, token);
		return edit && !token.isCancellationRequested ? { edits: [edit], dispose() {} } : undefined;
	}

	async provideDocumentDropEdits(
		_model: ITextModel,
		_position: IPosition,
		transfer: IReadonlyVSDataTransfer,
		token: CancellationToken,
	): Promise<DocumentDropEditsSession | undefined> {
		const edit = await this.getEdit(transfer, token);
		return edit && !token.isCancellationRequested ? { edits: [edit as DocumentDropEdit], dispose() {} } : undefined;
	}

	protected abstract getEdit(transfer: IReadonlyVSDataTransfer, token: CancellationToken): Promise<TransferEdit | undefined>;
}

export class DefaultTextPasteOrDropEditProvider extends TransferProvider {
	static readonly id = 'text';
	readonly id = DefaultTextPasteOrDropEditProvider.id;
	readonly pasteMimeTypes = [Mimes.text];
	readonly dropMimeTypes = [Mimes.text];

	constructor() {
		super(textKind);
	}

	protected async getEdit(transfer: IReadonlyVSDataTransfer): Promise<TransferEdit | undefined> {
		if (transfer.has(Mimes.uriList)) return undefined;
		const item = transfer.get(Mimes.text);
		if (!item || item.asFile()) return undefined;
		return {
			title: localize('dropOrPaste.plainText', 'Insert Plain Text'),
			kind: this.kind,
			handledMimeType: Mimes.text,
			insertText: await item.asString(),
		};
	}
}

class AbsolutePathProvider extends TransferProvider {
	readonly pasteMimeTypes = [Mimes.uriList];
	readonly dropMimeTypes = [Mimes.uriList];

	constructor() {
		super(absolutePathKind);
	}

	protected async getEdit(transfer: IReadonlyVSDataTransfer): Promise<TransferEdit | undefined> {
		const uris = await readUris(transfer);
		if (uris.length === 0) return undefined;
		const allFiles = uris.every(({ uri }) => uri.scheme === 'file');
		return {
			title: allFiles
				? localize('dropOrPaste.absolutePaths', 'Insert Paths')
				: localize('dropOrPaste.uris', 'Insert URIs'),
			kind: this.kind,
			handledMimeType: Mimes.uriList,
			insertText: uris.map(({ uri, source }) => uri.scheme === 'file' ? uri.fsPath : source).join(' '),
		};
	}
}

class RelativePathProvider extends TransferProvider {
	readonly pasteMimeTypes = [Mimes.uriList];
	readonly dropMimeTypes = [Mimes.uriList];

	constructor(private readonly workspace: IWorkspaceContextService) {
		super(relativePathKind);
	}

	protected async getEdit(transfer: IReadonlyVSDataTransfer): Promise<TransferEdit | undefined> {
		const uris = await readUris(transfer);
		const paths = uris.flatMap(({ uri }) => {
			const folder = this.workspace.getWorkspace().folders.find(candidate =>
				candidate.uri.scheme === uri.scheme
				&& candidate.uri.authority === uri.authority
				&& uri.path.startsWith(`${candidate.uri.path.replace(/\/$/u, '')}/`));
			return folder ? [uri.path.slice(folder.uri.path.replace(/\/$/u, '').length + 1)] : [];
		});
		if (paths.length === 0) return undefined;
		return {
			title: localize('dropOrPaste.relativePaths', 'Insert Relative Paths'),
			kind: this.kind,
			handledMimeType: Mimes.uriList,
			insertText: paths.join(' '),
		};
	}
}

class HtmlPasteProvider implements DocumentPasteEditProvider {
	readonly copyMimeTypes: readonly string[] = [];
	readonly pasteMimeTypes = [Mimes.html];
	readonly providedPasteEditKinds = [htmlKind];

	async provideDocumentPasteEdits(
		_model: ITextModel,
		_ranges: readonly IRange[],
		transfer: IReadonlyVSDataTransfer,
		context: DocumentPasteContext,
		token: CancellationToken,
	): Promise<DocumentPasteEditsSession | undefined> {
		if (context.triggerKind !== DocumentPasteTriggerKind.PasteAs && !context.only?.contains(htmlKind)) return undefined;
		const markup = await transfer.get(Mimes.html)?.asString();
		if (!markup || token.isCancellationRequested) return undefined;
		return {
			edits: [{ title: localize('dropOrPaste.html', 'Insert HTML'), kind: htmlKind, insertText: markup, yieldTo: [{ mimeType: Mimes.text }] }],
			dispose() {},
		};
	}
}

async function readUris(transfer: IReadonlyVSDataTransfer): Promise<{ uri: URI; source: string }[]> {
	const value = await transfer.get(Mimes.uriList)?.asString();
	if (!value) return [];
	const result: { uri: URI; source: string }[] = [];
	for (const source of UriList.parse(value)) {
		if (!source.trim()) continue;
		try {
			result.push({ uri: URI.parse(source), source });
		} catch {
			// Other providers can still handle malformed clipboard data.
		}
	}
	return result;
}

export class DefaultPasteProvidersFeature extends Disposable {
	constructor(features: ILanguageFeaturesService, workspace: IWorkspaceContextService) {
		super();
		for (const provider of [new DefaultTextPasteOrDropEditProvider(), new AbsolutePathProvider(), new RelativePathProvider(workspace), new HtmlPasteProvider()]) {
			this._register(features.documentPasteEditProvider.register(allModels, provider));
		}
	}
}

export class DefaultDropProvidersFeature extends Disposable {
	constructor(features: ILanguageFeaturesService, workspace: IWorkspaceContextService) {
		super();
		for (const provider of [new DefaultTextPasteOrDropEditProvider(), new AbsolutePathProvider(), new RelativePathProvider(workspace)]) {
			this._register(features.documentDropEditProvider.register(allModels, provider));
		}
	}
}
