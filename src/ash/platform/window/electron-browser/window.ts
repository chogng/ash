import { addDisposableListener } from '../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { INativeHostApi } from '../../native/common/nativeHost.js';
import type { IWindowClientSize } from '../common/window.js';

/** Applies the physical client bounds to one renderer container at its own zoom level. */
export class NativeWindowClientArea extends Disposable {
	readonly ready: Promise<void>;

	constructor(container: HTMLElement, host: INativeHostApi, windowName?: string, relayout?: () => void) {
		super();
		const target = container.ownerDocument.defaultView!;
		const originalWidth = container.style.maxWidth;
		const originalHeight = container.style.maxHeight;
		let size: IWindowClientSize | undefined;
		let revision = 0;
		let frame: number | undefined;
		const update = (): void => {
			if (frame !== undefined || this.isDisposed) return;
			frame = target.requestAnimationFrame(() => {
				frame = undefined;
				const scale = target.devicePixelRatio;
				// A native sample can lag the viewport. The percentage floor tracks
				// the containing block immediately and limits rounding correction to
				// one physical pixel while the next sample is in flight.
				const floor = `calc(100% - ${1 / scale}px)`;
				const maxWidth = size ? `max(${size.width / scale}px, ${floor})` : originalWidth;
				const maxHeight = size ? `max(${size.height / scale}px, ${floor})` : originalHeight;
				if (container.style.maxWidth === maxWidth && container.style.maxHeight === maxHeight) return;
				container.style.maxWidth = maxWidth;
				container.style.maxHeight = maxHeight;
				relayout?.();
			});
		};
		const subscription = host.onDidChangeWindowClientSize(value => {
			revision++;
			size = value;
			update();
		}, windowName);
		this._register(toDisposable(() => {
			subscription.dispose();
			if (frame !== undefined) target.cancelAnimationFrame(frame);
			container.style.maxWidth = originalWidth;
			container.style.maxHeight = originalHeight;
		}));
		this._register(addDisposableListener(target, 'resize', update));
		// Subscribe before reading so a late initial reply cannot replace a newer resize.
		const currentRevision = revision;
		this.ready = host.getWindowClientSize(windowName).then(initial => {
			if (this.isDisposed || revision !== currentRevision) return;
			size = initial;
			update();
		});
	}
}
