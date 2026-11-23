import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { toDisposable, type DisposableStore } from '../../../../../base/common/lifecycle.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { getWebviewContentMimeType } from '../../../../../platform/webview/common/mimeTypes.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { loadLocalResource } from '../../../webview/browser/resourceLoading.js';

export class ArkdownFileResources {
	constructor(
		private readonly document: URI,
		private readonly files: IFileService,
		private readonly workspace: IWorkspaceContextService,
	) { }

	resolveLink(href: string): string | undefined {
		if (!URL.canParse(href, this.document.toString())) return undefined;
		const url = new URL(href, this.document.toString());
		if (!['http:', 'https:', 'mailto:', 'file:', 'ash-remote:'].includes(url.protocol)) return undefined;
		return /^[a-z][\w+.-]*:/iu.test(href) ? href : url.href;
	}

	async loadImage(image: HTMLImageElement, src: string, lifetime: DisposableStore): Promise<void> {
		if (this.document.scheme === Schemas.untitled || /[\u0000-\u0020\u007f\\]|%2f|%5c|^(?:[a-z][\w+.-]*:|\/\/)/iu.test(src)) return;
		if (!URL.canParse(src, this.document.toString())) return;
		const resource = URI.parse(new URL(src, this.document.toString()).href);
		if (resource.scheme !== this.document.scheme || resource.authority !== this.document.authority || !getWebviewContentMimeType(resource).startsWith('image/')) return;

		const roots = [...this.workspace.getWorkspace().folders.map(folder => folder.uri), dirname(this.document)];
		const cancellation = new CancellationTokenSource();
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		try {
			const { bytes, mimeType } = await loadLocalResource(resource, { roots }, this.files, cancellation.token);
			if (!bytes || lifetime.isDisposed) return;
			const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
			lifetime.add(toDisposable(() => URL.revokeObjectURL(url)));
			image.src = url;
		} catch {
			// Keep the image's alternative text when its resource is unavailable.
		}
	}
}
