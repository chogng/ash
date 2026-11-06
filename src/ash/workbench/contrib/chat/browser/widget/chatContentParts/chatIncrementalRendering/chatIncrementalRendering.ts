import { getWindow, scheduleAtNextAnimationFrame } from '../../../../../../../base/browser/dom.js';
import type { IMarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';

export const markdownFrameThreshold = 1024;

/** Buffers the latest response snapshot and commits it through the owning Markdown part. */
export class IncrementalDOMMorpher extends Disposable {
	private readonly frame = this._register(new MutableDisposable());
	private snapshot: { readonly markdown: IMarkdownString; readonly incomplete: boolean; } | undefined;

	constructor(
		private readonly element: HTMLElement,
		private visible: boolean,
		private readonly sizeLimit: number,
		private readonly commit: (markdown: IMarkdownString, incomplete: boolean, fromFrame: boolean) => void,
	) {
		super();
	}

	get isVisible(): boolean { return this.visible; }
	get pending() { return this.snapshot; }

	/** Accepts a snapshot that can be queued without touching the live DOM. */
	tryMorph(markdown: IMarkdownString, incomplete: boolean): boolean {
		if (this.isDisposed || !this.visible || markdown.value.length > this.sizeLimit) return false;
		// Corrections and completion can supersede any snapshot in this frame.
		this.snapshot = { markdown, incomplete };
		if (!this.frame.value) {
			this.frame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
				this.frame.clear();
				const snapshot = this.snapshot;
				this.snapshot = undefined;
				if (snapshot) this.commit(snapshot.markdown, snapshot.incomplete, true);
			});
		}
		return true;
	}

	update(markdown: IMarkdownString, incomplete: boolean): void {
		// Keep size admission synchronous, including while the response is hidden.
		if (markdown.value.length <= this.sizeLimit) {
			if (!this.visible) {
				this.snapshot = { markdown, incomplete };
				return;
			}
			if (markdown.value.length >= markdownFrameThreshold && this.tryMorph(markdown, incomplete)) return;
		}
		this.frame.clear();
		this.snapshot = undefined;
		this.commit(markdown, incomplete, false);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.frame.clear();
		} else if (this.snapshot) {
			const { markdown, incomplete } = this.snapshot;
			this.snapshot = undefined;
			// Showing a response uses the same synchronous or deferred admission.
			this.update(markdown, incomplete);
		}
	}

	protected override disposeCore(): void {
		this.snapshot = undefined;
		super.disposeCore();
	}
}
