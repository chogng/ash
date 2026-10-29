import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { containsDragType, DataTransfers } from '../../../../../base/browser/dnd.js';
import { Mimes, getMediaMime } from '../../../../../base/common/mime.js';
import { URI } from '../../../../../base/common/uri.js';
import { extUri } from '../../../../../base/common/resources.js';
import { Schemas } from '../../../../../base/common/network.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { getPathForFile } from '../../../../../platform/dnd/browser/dnd.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { extractSelection } from '../../../../../platform/opener/common/opener.js';
import { IChatAttachmentResolveService } from '../attachments/chatAttachmentResolveService.js';
import { createChatFileAttachments } from './input/editor/chatPasteProviders.js';
import type { IChatInputPart } from './input/chatInputPart.js';

interface ResourceDrop {
	readonly files: readonly File[];
	readonly resources: readonly URI[];
}

/** Receives source resources; preparation, captured content and undo belong to the original composer. */
export class ChatDragAndDrop extends Disposable {
	constructor(
		private readonly target: IChatInputPart,
		private readonly supportsImages: () => boolean,
		@IFileService private readonly files: IFileService,
		@IChatAttachmentResolveService private readonly resolver: IChatAttachmentResolveService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	public addOverlay(target: HTMLElement, overlayContainer: HTMLElement): void {
		const resources = this._register(new DisposableStore());
		const overlay = h(target.ownerDocument, 'div');
		overlay.className = 'ash-chat-drop-overlay';
		overlay.textContent = localize('chat.attach.drop', 'Drop files, folders or references to attach');
		overlay.hidden = true;
		overlayContainer.append(overlay);
		resources.add(toDisposable(() => overlay.remove()));
		resources.add(
			addDisposableListener(target, 'dragover', event => {
				if (!hasResourceTransfer(event)) {
					overlay.hidden = true;
					return;
				}
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
				overlay.hidden = false;
			}),
		);
		resources.add(
			addDisposableListener(target, 'dragleave', event => {
				if (!target.contains(event.relatedTarget as Node | null)) {
					overlay.hidden = true;
				}
			}),
		);
		resources.add(
			addDisposableListener(
				target.ownerDocument,
				'dragend',
				() => {
					overlay.hidden = true;
				},
				true,
			),
		);
		resources.add(
			addDisposableListener(
				target,
				'drop',
				event => {
					overlay.hidden = true;
					if (!event.dataTransfer || !hasResourceTransfer(event)) return;
					let drop: ResourceDrop;
					try {
						// Native transfer values are readable only during this event, before any await.
						drop = readResourceDrop(event.dataTransfer);
					} catch (error) {
						event.preventDefault();
						event.stopPropagation();
						this.reportError(error);
						return;
					}
					if (!drop.files.length && !drop.resources.length) return;
					event.preventDefault();
					event.stopPropagation();
					void this.accept(drop);
				},
				true,
			),
		);
	}

	private async accept(drop: ResourceDrop): Promise<void> {
		try {
			const accepted = await this.target.acquireContext(async signal => {
				const batch = new AbortController();
				signal = AbortSignal.any([signal, batch.signal]);
				try {
					const [resources, native] = await Promise.all([
						Promise.all(
							drop.resources.map(async resource => {
								if (signal.aborted) throw new CancellationError();
								const uri = extractSelection(resource).uri;
								const hasProvider = this.files.hasProvider(uri);
								const directory =
									hasProvider && (await this.files.stat(uri)).kind === FileKind.Directory;
								if (
									hasProvider &&
									!directory &&
									/^image\/(png|jpeg|gif|webp)$/u.test(getMediaMime(uri.path) ?? '') &&
									!this.supportsImages()
								) {
									throw new Error(
										localize(
											'chat.image.unsupported',
											'The selected model does not support images',
										),
									);
								}
								if (signal.aborted) throw new CancellationError();
								return this.resolver.resolveResourceAttachContext(resource, directory, signal);
							}),
						),
						createChatFileAttachments(drop.files, signal, this.supportsImages, this.resolver),
					]);
					if (signal.aborted) throw new CancellationError();
					const attachments = [...resources, ...native];
					if (attachments.some(attachment => attachment.kind === 'image') && !this.supportsImages()) {
						throw new Error(
							localize('chat.image.unsupported', 'The selected model does not support images'),
						);
					}
					return attachments;
				} catch (error) {
					batch.abort();
					throw error;
				}
			});
			if (!this.isDisposed) {
				status(localize('chat.context.filesAdded', 'Added {0} attachments', accepted.length));
				this.target.focus();
			}
		} catch (error) {
			this.reportError(error);
		}
	}

	private reportError(error: unknown): void {
		if (!this.isDisposed && !isCancellationError(error)) {
			this.notifications.error(localize('chat.attach.failed', 'Could not attach files: {0}', String(error)));
		}
	}
}

function hasResourceTransfer(event: DragEvent): boolean {
	return [DataTransfers.FILES, DataTransfers.RESOURCES, Mimes.uriList].some(type => containsDragType(event, type));
}

function readResourceDrop(transfer: DataTransfer): ResourceDrop {
	const encoded = transfer.getData(DataTransfers.RESOURCES);
	const uriList = transfer.getData(Mimes.uriList);
	const invalid = () => new Error(localize('chat.attach.invalidDrop', 'The dropped resources are invalid.'));
	if (encoded.length + uriList.length > 32 * 1024 * 1024) throw invalid();
	let values: string[];
	if (encoded) {
		let data: unknown;
		try {
			data = JSON.parse(encoded);
		} catch {
			throw invalid();
		}
		if (!Array.isArray(data) || !data.every(value => typeof value === 'string')) throw invalid();
		values = data;
	} else
		values = uriList
			.split(/\r?\n/u)
			.map(value => value.trim())
			.filter(value => value && !value.startsWith('#'));
	const native = [...transfer.files];
	if (values.length + native.length > 1000) throw invalid();
	const resources = new Map<string, URI>();
	for (const value of values) {
		let resource: URI;
		try {
			resource = URI.parse(value);
		} catch {
			throw invalid();
		}
		if (![Schemas.file, Schemas.ashRemote, Schemas.untitled, Schemas.vscodeUserData].includes(resource.scheme)) {
			if (encoded) throw invalid();
			continue;
		}
		resources.set(extUri.getComparisonKey(resource), resource);
	}
	const aliases = new Set(
		[...resources.values()].map(resource => extUri.getComparisonKey(extractSelection(resource).uri)),
	);
	const files = native.filter(file => {
		const path = getPathForFile(file);
		return !path || !aliases.has(extUri.getComparisonKey(URI.file(path)));
	});
	return { files, resources: [...resources.values()] };
}
