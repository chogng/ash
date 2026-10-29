import { Range } from '../../../../../editor/common/core/range.js';
import type { LanguageWorkspaceSymbol } from '../../../../../editor/common/languages.js';
import { withSelection } from '../../../../../platform/opener/common/opener.js';
import { readWorkspaceSymbolSource } from '../../../search/common/search.js';
import { SCMHistoryItemUri, type SCMHistoryItemViewModelTreeElement, type SCMHistoryItemChangeViewModelTreeElement } from '../../../scm/common/history.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import { extname } from '../../../../../base/common/path.js';
import type { URI } from '../../../../../base/common/uri.js';
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
	) {}

	public async resolveEditorAttachContext(editor: IResourceEditorInput, signal?: AbortSignal): Promise<ChatContextAttachment | undefined> {
		if (editor.resource.scheme === 'untitled') return this.resolveUntitledEditorAttachContext(editor, signal);
		if (isBinaryDiffEditorInput(editor)) {
			return undefined;
		}
		const input = isResourceDiffEditorInput(editor) ? editor.modified : editor;
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
		const snapshotText =
			input.readOnly && input.initialText !== undefined
				? input.initialText
				: (this.workingCopies
						.get(input.resource)
						.find(copy => copy.backupKind === 'text')
						?.backup() ?? input.initialText);
		if (snapshotText === undefined && !this.files.hasProvider(input.resource)) {
			return undefined;
		}
		// Versioned editors can supply their displayed text without a file provider.
		return this.capture(input.resource, false, signal, snapshotText);
	}

	public async resolveUntitledEditorAttachContext(editor: IResourceEditorInput, signal?: AbortSignal): Promise<ChatContextAttachment | undefined> {
		const content =
			editor.readOnly && editor.initialText !== undefined
				? editor.initialText
				: (this.workingCopies
						.get(editor.resource)
						.find(copy => copy.backupKind === 'text')
						?.backup() ?? editor.initialText);
		return content === undefined ? undefined : this.capture(editor.resource, false, signal, content);
	}

	public async resolveSymbolsAttachContext(symbols: readonly LanguageWorkspaceSymbol[], signal?: AbortSignal): Promise<ChatContextAttachment[]> {
		return Promise.all(
			symbols.map(async symbol => {
				if (signal?.aborted) throw new CancellationError();
				const source = await readWorkspaceSymbolSource(symbol, this.files, this.workingCopies);
				if (signal?.aborted) throw new CancellationError();
				if (source === undefined) throw new Error(localize('chat.context.symbolChanged', 'The symbol source changed. Search again to attach its current code.'));
				const data = symbol.data as { source?: unknown; declarationRange?: unknown } | undefined;
				const range = data?.source === 'codebaseSymbols' && Range.isIRange(data.declarationRange) ? Range.lift(data.declarationRange) : symbol.range;
				const lines = source.split(/\r\n|\r|\n/u);
				const first = lines[range.startLineNumber - 1];
				const last = lines[range.endLineNumber - 1];
				if (
					first === undefined ||
					last === undefined ||
					range.startColumn < 1 ||
					range.endColumn < 1 ||
					range.startColumn > first.length + 1 ||
					range.endColumn > last.length + 1 ||
					range.endLineNumber < range.startLineNumber ||
					(range.endLineNumber === range.startLineNumber && range.endColumn < range.startColumn)
				) {
					throw new Error(localize('chat.context.symbolRangeUnavailable', 'The symbol source range is no longer available'));
				}
				const code =
					range.startLineNumber === range.endLineNumber
						? first.slice(range.startColumn - 1, range.endColumn - 1)
						: [first.slice(range.startColumn - 1), ...lines.slice(range.startLineNumber, range.endLineNumber - 1), last.slice(0, range.endColumn - 1)].join('\n');
				if (!code.trim()) throw new Error(localize('chat.context.symbolEmpty', 'The symbol has no source text to attach'));
				const resource = withSelection(symbol.resource, range);
				const name = symbol.name;
				const content = `Symbol: ${name}\nSource: ${resource.toString()}\n\n${code.length > 100_000 ? code.slice(0, 100_000) + '\n[Additional code omitted]' : code}`;
				return {
					id: `symbol:${resource.toString()}:${name}`,
					kind: 'symbol',
					resource,
					name,
					resolve: async () => ({ name, content }),
				};
			}),
		);
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
				kind: path ? 'scmHistoryItemChange' : 'scmHistoryItem',
				name,
				resource: SCMHistoryItemUri.toUri({ repositoryId: repository.id, revision, baseRevision, path }),
				resolve: async () => {
					const content =
						path === undefined ? await provider.resolveHistoryItemChatContext(revision) : await provider.resolveHistoryItemChangeRangeChatContext(revision, baseRevision ?? '', path);
					if (content === undefined) throw new Error(path === undefined ? `History item '${revision}' is unavailable` : `History change '${path}' is unavailable`);
					return { name: contentName, content };
				},
			};
		});
	}

	public async resolveResourceAttachContext(resource: URI, isDirectory: boolean, signal?: AbortSignal): Promise<ChatContextAttachment> {
		if (!isDirectory) {
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
		return Promise.all(
			images.map(async image => {
				if (signal?.aborted) {
					throw new CancellationError();
				}
				const attachment = await createImageAttachment(image.name, image.data, image.mimeType ?? 'image/png');
				if (signal?.aborted) {
					throw new CancellationError();
				}
				return image.resource ? { ...attachment, resource: image.resource } : attachment;
			}),
		);
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
			const found = await this.search.glob(
				{ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } },
				{
					includePatterns: prefix ? [`${prefix.replace(/[\\*?{}[\]]/gu, '\\$&')}**`] : [],
					excludePatterns: [],
					maxResults: 1000,
				},
				signal,
			);
			// Directory context carries a bounded manifest, not copies of every file.
			content = `Directory: ${resource.toString()}\nFiles:\n${found.matches.map(file => file.path.slice(prefix.length)).join('\n')}`;
			if (found.totalMatches > found.matches.length) {
				content += `\n… (${found.totalMatches - found.matches.length} additional files)`;
			}
		} else {
			content =
				snapshotText ??
				this.workingCopies
					.get(uri)
					.find(copy => copy.backupKind === 'text')
					?.backup() ??
				(await this.files.readFile(uri)).content;
			if (selection?.endLineNumber !== undefined) {
				const lines = content.split(/\r\n|\r|\n/u);
				const start = lines[selection.startLineNumber - 1];
				const end = lines[selection.endLineNumber - 1];
				const endColumn = selection.endColumn ?? 1;
				if (
					start === undefined ||
					end === undefined ||
					selection.startColumn > start.length + 1 ||
					endColumn > end.length + 1 ||
					selection.endLineNumber < selection.startLineNumber ||
					(selection.endLineNumber === selection.startLineNumber && endColumn < selection.startColumn)
				) {
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
		return {
			id: `file:${extUri.getComparisonKey(resource)}`,
			kind,
			resource,
			name,
			resolve: async () => ({ name, content }),
		};
	}
}
