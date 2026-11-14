import { IImageResizeService } from '../../../../../platform/imageResize/common/imageResizeService.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { getMediaMime, Mimes } from '../../../../../base/common/mime.js';
import { getPathForFile } from '../../../../../platform/dnd/browser/dnd.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { LanguageWorkspaceSymbol } from '../../../../../editor/common/languages.js';
import { withSelection } from '../../../../../platform/opener/common/opener.js';
import { readWorkspaceSymbolSource } from '../../../search/common/search.js';
import { SCMHistoryItemUri, type SCMHistoryItemViewModelTreeElement, type SCMHistoryItemChangeViewModelTreeElement } from '../../../scm/common/history.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import { extname } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { isResourceDiffEditorInput, type IResourceEditorInput } from '../../../../common/editor.js';
import { isBinaryDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { createImageAttachment } from '../chatImageUtils.js';
import { extractSelection } from '../../../../../platform/opener/common/opener.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IChatContextService } from '../contextContrib/chatContextService.js';

export type ImageTransferData = {
	readonly data: Uint8Array;
	readonly name: string;
	readonly resource?: URI;
	readonly mimeType?: string;
};

const imageMimeTypes: Readonly<Record<string, string>> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

export const IChatAttachmentResolveService = createServiceIdentifier<IChatAttachmentResolveService>('chatAttachmentResolveService');

/** Captures selected resources; draft ownership and admission remain with the composer. */
export interface IChatAttachmentResolveService {
	readonly _serviceBrand: undefined;
	resolveUntitledEditorAttachContext(editor: IResourceEditorInput, signal?: AbortSignal): Promise<ChatContextAttachment | undefined>;
	resolveSymbolsAttachContext(symbols: readonly LanguageWorkspaceSymbol[], signal?: AbortSignal): Promise<ChatContextAttachment[]>;
	resolveSourceControlHistoryItemAttachContext(data: readonly (SCMHistoryItemViewModelTreeElement | SCMHistoryItemChangeViewModelTreeElement)[]): ChatContextAttachment[];
	resolveEditorAttachContext(editor: IResourceEditorInput, signal?: AbortSignal): Promise<ChatContextAttachment | undefined>;
	resolveResourceAttachContext(resource: URI, isDirectory: boolean, signal?: AbortSignal): Promise<ChatContextAttachment>;
	resolveImageEditorAttachContext(resource: URI, data?: VSBuffer, mimeType?: string, signal?: AbortSignal): Promise<ChatContextAttachment | undefined>;
	resolveImageAttachContext(images: readonly ImageTransferData[], signal?: AbortSignal): Promise<ChatContextAttachment[]>;
}

export class ChatAttachmentResolveService implements IChatAttachmentResolveService {
	declare readonly _serviceBrand: undefined;
	constructor(
		@IFileService private readonly files: IFileService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IFileSearchService private readonly search: IFileSearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IChatContextService private readonly contexts: IChatContextService,
		@IImageResizeService private readonly imageResize: IImageResizeService,
	) { }

	public async resolveEditorAttachContext(editor: IResourceEditorInput, signal?: AbortSignal): Promise<ChatContextAttachment | undefined> {
		if (isBinaryDiffEditorInput(editor)) {
			return undefined;
		}
		const input = isResourceDiffEditorInput(editor) ? editor.modified : editor;
		const provided = await this.resolveProviderContext(input.resource, signal, input.languageId, input.editorId);
		if (provided) return provided;
		if (input.resource.scheme === 'untitled') return this.resolveUntitledEditorAttachContext(input, signal);
		const imageData = input.initialBytes ? VSBuffer.wrap(new Uint8Array(input.initialBytes)) : undefined;
		const image = await this.resolveImageEditorAttachContext(input.resource, imageData, input.contentType, signal);
		if (image) {
			return image;
		}
		if (input.initialBytes || input.contentType === 'application/octet-stream') {
			return undefined;
		}
		// A readonly editor's explicit content is its displayed version, even when a live
		// working copy exists at the same URI. Editable inputs still use unsaved edits.
		const snapshotText = input.readOnly && input.initialText !== undefined ? input.initialText
			: this.workingCopies.get(input.resource).find(copy => copy.backupKind === 'text')?.backup() ?? input.initialText;
		if (snapshotText === undefined && !this.files.hasProvider(input.resource)) {
			return undefined;
		}
		// Versioned editors can supply their displayed text without a file provider.
		return this.capture(input.resource, false, signal, snapshotText);
	}


	public async resolveUntitledEditorAttachContext(editor: IResourceEditorInput, signal?: AbortSignal): Promise<ChatContextAttachment | undefined> {
		const content = editor.readOnly && editor.initialText !== undefined ? editor.initialText : this.workingCopies.get(editor.resource).find(copy => copy.backupKind === 'text')?.backup() ?? editor.initialText;
		return content === undefined ? undefined : this.capture(editor.resource, false, signal, content);
	}

	public async resolveSymbolsAttachContext(symbols: readonly LanguageWorkspaceSymbol[], signal?: AbortSignal): Promise<ChatContextAttachment[]> {
		return Promise.all(symbols.map(async symbol => {
			if (signal?.aborted) throw new CancellationError();
			const source = await readWorkspaceSymbolSource(symbol, this.files, this.workingCopies);
			if (signal?.aborted) throw new CancellationError();
			if (source === undefined) throw new Error(localize('chat.context.symbolChanged', 'The symbol source changed. Search again to attach its current code.'));
			const data = symbol.data as { source?: unknown; declarationRange?: unknown; } | undefined;
			const range = data?.source === 'codebaseSymbols' && Range.isIRange(data.declarationRange) ? Range.lift(data.declarationRange) : symbol.range;
			const lines = source.split(/\r\n|\r|\n/u);
			const first = lines[range.startLineNumber - 1];
			const last = lines[range.endLineNumber - 1];
			if (first === undefined || last === undefined || range.startColumn < 1 || range.endColumn < 1 || range.startColumn > first.length + 1 || range.endColumn > last.length + 1
				|| range.endLineNumber < range.startLineNumber || range.endLineNumber === range.startLineNumber && range.endColumn < range.startColumn) {
				throw new Error(localize('chat.context.symbolRangeUnavailable', 'The symbol source range is no longer available'));
			}
			const code = range.startLineNumber === range.endLineNumber ? first.slice(range.startColumn - 1, range.endColumn - 1)
				: [first.slice(range.startColumn - 1), ...lines.slice(range.startLineNumber, range.endLineNumber - 1), last.slice(0, range.endColumn - 1)].join('\n');
			if (!code.trim()) throw new Error(localize('chat.context.symbolEmpty', 'The symbol has no source text to attach'));
			const resource = withSelection(symbol.resource, range);
			const name = symbol.name;
			const content = `Symbol: ${name}\nSource: ${resource.toString()}\n\n${code.length > 100_000 ? code.slice(0, 100_000) + '\n[Additional code omitted]' : code}`;
			return { id: `symbol:${resource.toString()}:${name}`, kind: 'symbol', resource, name, resolve: async () => ({ name, content }) };
		}));
	}

	public resolveSourceControlHistoryItemAttachContext(data: readonly (SCMHistoryItemViewModelTreeElement | SCMHistoryItemChangeViewModelTreeElement)[]): ChatContextAttachment[] {
		return data.map(element => {
			const { repository, historyItemViewModel } = element;
			const item = historyItemViewModel.historyItem;
			const provider = repository.provider.historyProvider;
			if (!provider) throw new Error(`Repository '${repository.id}' does not provide history`);
			const revision = item.comparison?.revision ?? item.id;
			const change = element.type === 'historyItemChangeViewModel' ? element.historyItemChange : undefined;
			const baseRevision = change?.parentId ?? item.comparison?.baseRevision ?? item.parentIds[0];
			const path = change?.path;
			const name = path ?? `${item.displayId ?? item.id} · ${item.subject}`;
			const contentName = path ? `${item.displayId ?? item.id} · ${path}` : name;
			return {
				id: `${repository.id}:${item.id}${path ? `:${path}` : ''}`,
				kind: path ? 'scmHistoryItemChange' : 'scmHistoryItem', name,
				resource: SCMHistoryItemUri.toUri({ repositoryId: repository.id, revision, baseRevision, path }),
				resolve: async () => {
					const content = path === undefined ? await provider.resolveHistoryItemChatContext(revision)
						: await provider.resolveHistoryItemChangeRangeChatContext(revision, baseRevision ?? '', path);
					if (content === undefined) throw new Error(path === undefined ? `History item '${revision}' is unavailable` : `History change '${path}' is unavailable`);
					return { name: contentName, content };
				},
			};
		});
	}

	public async resolveResourceAttachContext(resource: URI, isDirectory: boolean, signal?: AbortSignal): Promise<ChatContextAttachment> {
		if (!isDirectory) {
			const provided = await this.resolveProviderContext(resource, signal);
			if (provided) return provided;
			const image = await this.resolveImageEditorAttachContext(extractSelection(resource).uri, undefined, undefined, signal);
			if (image) {
				return { ...image, resource };
			}
		}
		return this.capture(resource, isDirectory, signal);
	}

	public async resolveImageEditorAttachContext(resource: URI, data?: VSBuffer, mimeType?: string, signal?: AbortSignal): Promise<ChatContextAttachment | undefined> {
		mimeType = Object.values(imageMimeTypes).includes(mimeType ?? '') ? mimeType : imageMimeTypes[extname(resource.path).toLowerCase()];
		if (!mimeType) {
			return undefined;
		}
		if (signal?.aborted) {
			throw new CancellationError();
		}
		const name = basename(resource);
		let bytes: Uint8Array | undefined = data?.buffer;
		if (!bytes) {
			if (!this.files.hasProvider(resource)) {
				return undefined;
			}
			const stat = await this.files.stat(resource);
			if (signal?.aborted) {
				throw new CancellationError();
			}
			if (stat.sizeBytes > 20 * 1024 * 1024) {
				throw new Error(localize('chat.image.tooLarge', '{0} exceeds the 20 MB image limit', name));
			}
			bytes = (await this.files.readFileBytes(resource)).bytes;
		}
		const [attachment] = await this.resolveImageAttachContext([{ name, data: bytes, mimeType, resource }], signal);
		return attachment;
	}

	public async resolveImageAttachContext(images: readonly ImageTransferData[], signal?: AbortSignal): Promise<ChatContextAttachment[]> {
		return Promise.all(images.map(async image => {
			if (signal?.aborted) {
				throw new CancellationError();
			}
			const attachment = await createImageAttachment(image.name, image.data, image.mimeType ?? 'image/png', this.imageResize);
			if (signal?.aborted) {
				throw new CancellationError();
			}
			return image.resource ? { ...attachment, resource: image.resource } : attachment;
		}));
	}

	private async resolveProviderContext(resource: URI, signal?: AbortSignal, language?: string, viewType?: string): Promise<ChatContextAttachment | undefined> {
		if (signal?.aborted) throw new CancellationError();
		using cancellation = new CancellationTokenSource();
		using listener = signal ? addDisposableListener(signal, 'abort', () => cancellation.cancel()) : undefined;
		const context = await this.contexts.contextForResource(resource, language, viewType, cancellation.token);
		if (!context) return undefined;
		const resolved = context.value === undefined ? await this.contexts.resolveChatContext(context, language, cancellation.token) : context;
		if (signal?.aborted) throw new CancellationError();
		if (resolved.value === undefined) throw new Error(localize('chat.context.providerNoContent', 'The context provider did not return any content.'));
		const name = resolved.name ?? basename(resource);
		const content = resolved.modelDescription ? `${resolved.modelDescription}\n\n${resolved.value}` : resolved.value;
		const handle = resolved.handle;
		return {
			id: `chat-context:${resource.toString()}:${resolved.handle}`, kind: 'generic', name,
			resource: resolved.resourceUri ?? resource, iconPath: resolved.iconPath, tooltip: resolved.tooltip,
			open: resolved.commandId ? () => this.contexts.executeChatContextItemCommand(handle) : undefined,
			resolve: async () => ({ name, content }),
		};
	}

	private async capture(resource: URI, isDirectory: boolean, signal?: AbortSignal, snapshotText?: string): Promise<ChatContextAttachment> {
		if (signal?.aborted) {
			throw new CancellationError();
		}
		const { uri, selection } = extractSelection(resource);
		let name = basename(uri) || uri.path;
		let content: string;
		if (isDirectory) {
			const folder = this.workspace.getWorkspaceFolder(resource);
			if (!folder) {
				throw new Error(localize('chat.context.folderUnavailable', 'The folder is outside the current workspace'));
			}
			const relative = resource.path.slice(folder.uri.path.replace(/\/$/u, '').length).replace(/^\//u, '');
			const prefix = relative ? `${relative}/` : '';
			const found = await this.search.glob({ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } }, {
				includePatterns: prefix ? [`${prefix.replace(/[\\*?{}[\]]/gu, '\\$&')}**`] : [],
				excludePatterns: [],
				maxResults: 1000,
			}, signal);
			// Directory context carries a bounded manifest, not copies of every file.
			content = `Directory: ${resource.toString()}\nFiles:\n${found.matches.map(file => file.path.slice(prefix.length)).join('\n')}`;
			if (found.totalMatches > found.matches.length) {
				content += `\n… (${found.totalMatches - found.matches.length} additional files)`;
			}
		} else {
			content = snapshotText ?? this.workingCopies.get(uri).find(copy => copy.backupKind === 'text')?.backup() ?? (await this.files.readFile(uri)).content;
			if (selection?.endLineNumber !== undefined) {
				const lines = content.split(/\r\n|\r|\n/u);
				const start = lines[selection.startLineNumber - 1];
				const end = lines[selection.endLineNumber - 1];
				const endColumn = selection.endColumn ?? 1;
				if (start === undefined || end === undefined || selection.startColumn > start.length + 1 || endColumn > end.length + 1
					|| selection.endLineNumber < selection.startLineNumber || selection.endLineNumber === selection.startLineNumber && endColumn < selection.startColumn) {
					throw new Error(localize('chat.attach.rangeUnavailable', 'The source range for {0} is no longer available.', name));
				}
				const offsets = [0, ...[...content.matchAll(/\r\n|\r|\n/gu)].map(match => match.index + match[0].length)];
				content = content.slice(offsets[selection.startLineNumber - 1]! + selection.startColumn - 1, offsets[selection.endLineNumber - 1]! + endColumn - 1);
				name += ` (${selection.startLineNumber}${selection.endLineNumber === selection.startLineNumber ? '' : `-${selection.endLineNumber}`})`;
			}
			if (content.includes('\0') || !content.trim()) {
				throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', name));
			}
		}
		if (signal?.aborted) {
			throw new CancellationError();
		}
		const kind = isDirectory ? 'directory' : selection?.endLineNumber === undefined ? 'file' : 'codeSelection';
		return { id: `file:${extUri.getComparisonKey(resource)}`, kind, resource, name, resolve: async () => ({ name, content }) };
	}
}

/** Captures browser/native files for both file selection and drag-and-drop admission. */
export async function createChatFileAttachments(
	files: readonly File[],
	signal: AbortSignal,
	supportsImages: () => boolean,
	attachments: Pick<IChatAttachmentResolveService, 'resolveImageAttachContext'>,
	onPreparingImage?: (file: File, mimeType: string) => void,
): Promise<readonly ChatContextAttachment[]> {
	const batch = new AbortController();
	signal = AbortSignal.any([signal, batch.signal]);
	try {
		const prepared = await Promise.all(files.map(async file => {
			if (signal.aborted) throw new CancellationError();
			const path = getPathForFile(file);
			const source = path ? { resource: URI.file(path) } : {};
			// Native file transfers can omit MIME or supply only a generic binary type.
			const mimeType = !file.type || file.type === Mimes.binary ? getMediaMime(file.name) : file.type;
			const imageMimeType = mimeType && /^image\/(png|jpeg|gif|webp)$/u.test(mimeType) ? mimeType : undefined;
			if (imageMimeType && !supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
			// Bound image allocation before reading; image processing also bounds the encoded result.
			if (imageMimeType && file.size > 20 * 1024 * 1024) throw new Error(localize('chat.image.tooLarge', '{0} exceeds the 20 MB image limit', file.name));
			if (imageMimeType && file.size > 0) onPreparingImage?.(file, imageMimeType);
			const bytes = await readFile(file, signal);
			if (!bytes.length) throw new Error(localize('chat.attach.empty', '{0} is empty', file.name));
			if (imageMimeType) {
				const [attachment] = await attachments.resolveImageAttachContext([{ name: file.name, data: bytes, mimeType: imageMimeType, ...source }], signal);
				if (signal.aborted) throw new CancellationError();
				if (!supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
				return attachment!;
			}
			let content: string;
			try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
			catch { throw new Error(localize('chat.attach.binary', '{0} must be a UTF-8 text file or a PNG, JPEG, GIF, or WebP image', file.name)); }
			if (content.includes('\0') || !content.trim()) throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', file.name));
			return { id: createUuid(), kind: 'file', name: file.name, ...source, resolve: async () => ({ name: file.name, content }) };
		}));
		// A text read can outlive image decoding; apply the current policy to the complete batch.
		if (signal.aborted) throw new CancellationError();
		if (prepared.some(attachment => attachment.kind === 'image') && !supportsImages()) {
			throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
		}
		return prepared;
	} catch (error) {
		batch.abort();
		throw error;
	}
}

function readFile(file: File, signal: AbortSignal): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new CancellationError()); return; }
		const reader = new FileReader();
		const resources = new DisposableStore();
		const finish = (bytes?: Uint8Array, error?: unknown): void => {
			resources.dispose();
			if (bytes) resolve(bytes); else reject(error);
		};
		resources.add(addDisposableListener(reader, 'load', () => finish(new Uint8Array(reader.result as ArrayBuffer))));
		resources.add(addDisposableListener(reader, 'error', () => finish(undefined, reader.error)));
		resources.add(addDisposableListener(reader, 'abort', () => finish(undefined, new CancellationError())));
		resources.add(addDisposableListener(signal, 'abort', () => reader.abort()));
		try { reader.readAsArrayBuffer(file); } catch (error) { finish(undefined, error); }
	});
}
