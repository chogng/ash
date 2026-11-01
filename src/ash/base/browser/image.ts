import { AbstractDisposable } from '../common/lifecycle.js';

/** The consuming view owns this URL; it is never a saved asset identity. */
export class ImageResource extends AbstractDisposable {
	public readonly url: string;

	constructor(bytes: Uint8Array, mediaType: string) {
		super();
		this.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
	}

	protected override disposeCore(): void {
		URL.revokeObjectURL(this.url);
	}
}
