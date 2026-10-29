import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_PIXELS, type DesktopScreenshot } from '../common/native.js';
import type { BrowserWindow } from 'electron/main';
import type { IRectangle } from '../../window/common/window.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { ITerminalWindowTransfer, ITerminalWindowTransferResult } from '../common/nativeHost.js';
import { VSBuffer } from '../../../base/common/buffer.js';

/** Main owns the sender's capture target and converts CSS coordinates to window DIPs. */
export async function getScreenshot(window: BrowserWindow, rect?: IRectangle): Promise<VSBuffer | undefined> {
	if (window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
	const zoom = window.webContents.getZoomFactor();
	const bounds = window.getContentBounds();
	if (
		rect &&
		((rect.x + rect.width) * zoom > bounds.width + 1 || (rect.y + rect.height) * zoom > bounds.height + 1)
	) {
		throw new RangeError('Screenshot rectangle is outside the window');
	}
	// Round both edges onto the same DIP grid; outward rounding adds pixels at fractional zoom.
	const clip = rect
		? {
				x: Math.round(rect.x * zoom),
				y: Math.round(rect.y * zoom),
				width: Math.max(1, Math.round((rect.x + rect.width) * zoom) - Math.round(rect.x * zoom)),
				height: Math.max(1, Math.round((rect.y + rect.height) * zoom) - Math.round(rect.y * zoom)),
			}
		: undefined;
	const image = await window.webContents.capturePage(clip);
	if (window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
	const bytes = image.toPNG();
	if (image.isEmpty() || bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024)
		throw new Error('Screenshot image is empty or too large');
	return VSBuffer.wrap(new Uint8Array(bytes));
}

/** Acquires display pixels only; the workbench owns selection, overlays and output actions. */
export async function getDesktopScreenshots(): Promise<readonly DesktopScreenshot[]> {
	const { desktopCapturer, screen } = await import('electron/main');
	const displays = screen.getAllDisplays();
	const width = Math.max(...displays.map(display => Math.ceil(display.size.width * display.scaleFactor)));
	const height = Math.max(...displays.map(display => Math.ceil(display.size.height * display.scaleFactor)));
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		width * height > SCREENSHOT_MAX_PIXELS
	)
		throw new Error('ScreenshotTooLarge');
	// Freeze every display before the caller can show overlays, including mixed-DPI desktops.
	const sources = await desktopCapturer
		.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
		.catch(error => {
			throw new Error('ScreenshotUnavailable', { cause: error });
		});
	return displays.map(display => {
		const source = sources.find(candidate => candidate.display_id === String(display.id));
		// Enumeration order is not a reliable display identity.
		if (!source || source.thumbnail.isEmpty()) throw new Error('ScreenshotUnavailable');
		const bytes = source.thumbnail.toPNG();
		const size = source.thumbnail.getSize();
		if (
			!bytes.byteLength ||
			bytes.byteLength > SCREENSHOT_MAX_BYTES ||
			size.width * size.height > SCREENSHOT_MAX_PIXELS
		)
			throw new Error('ScreenshotTooLarge');
		return { displayId: display.id, bounds: { ...display.bounds }, image: VSBuffer.wrap(new Uint8Array(bytes)) };
	});
}

/** Reads the desktop process's effective privilege, independently of its App Server. */
export async function isAdmin(): Promise<boolean> {
	if (process.platform === 'win32') {
		const { default: isElevated } = await import('native-is-elevated');
		return isElevated();
	}
	return process.geteuid!() === 0;
}

interface TerminalTransferWindow {
	readonly workspaceId: string;
	readonly remoteAuthority: string | undefined;
	requestTransfer(): void;
}

interface PendingTerminalTransfer {
	readonly transfer: ITerminalWindowTransfer;
	readonly sourceWindowId: number;
	readonly workspaceId: string;
	readonly remoteAuthority: string | undefined;
	targetWindowId: number | undefined;
	claimed: boolean;
	sourceReleased: boolean;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly resolve: (result: ITerminalWindowTransferResult) => void;
	readonly reject: (error: Error) => void;
}

/** Holds opaque terminal handoffs only for the lifetime of their two trusted windows. */
export class TerminalWindowTransferHost extends Disposable {
	private readonly pending = new Map<string, PendingTerminalTransfer>();

	constructor(
		private readonly host: {
			getWindow(windowId: number): TerminalTransferWindow | undefined;
			openWindow(sourceWindowId: number): Promise<number>;
		},
	) {
		super();
		this._register(
			toDisposable(() => {
				for (const pending of [...this.pending.values()])
					this.finish(pending, new Error('Terminal transfer host closed'));
			}),
		);
	}

	move(
		sourceWindowId: number,
		transfer: ITerminalWindowTransfer,
		targetWindowId?: number,
	): Promise<ITerminalWindowTransferResult> {
		// Preflight validates a live credential too, but an actual offer must have
		// completed detach and carry its bounded handoff lease.
		if (transfer.lease.reconnectGracePeriodMillis === 0)
			return Promise.reject(new Error('Terminal transfer requires a detached lease'));
		const source = this.host.getWindow(sourceWindowId);
		if (this.isDisposed || !source) return Promise.reject(new Error('Terminal source window is unavailable'));
		const sourceBusy = [...this.pending.values()].some(
			pending => pending.sourceWindowId === sourceWindowId || pending.targetWindowId === sourceWindowId,
		);
		if (this.pending.has(transfer.id) || this.pending.size >= 16 || sourceBusy)
			return Promise.reject(new Error('Terminal transfer is already pending'));
		if (targetWindowId === sourceWindowId)
			return Promise.reject(new Error('Terminal transfer requires another window'));
		return new Promise<ITerminalWindowTransferResult>((resolve, reject) => {
			const pending: PendingTerminalTransfer = {
				transfer,
				sourceWindowId,
				workspaceId: source.workspaceId,
				remoteAuthority: source.remoteAuthority,
				targetWindowId: undefined,
				claimed: false,
				sourceReleased: false,
				resolve,
				reject,
				// Leave time for the source to reattach before the execution owner's lease expires.
				timer: setTimeout(
					() => this.finish(pending, new Error('Terminal transfer timed out')),
					Math.max(0, Math.min(25_000, transfer.lease.reconnectGracePeriodMillis - 1_000)),
				),
			};
			this.pending.set(transfer.id, pending);
			void this.offer(pending, targetWindowId).catch(error => {
				this.finish(
					pending,
					error instanceof Error ? error : new Error('Terminal target window could not be opened'),
				);
			});
		});
	}

	take(targetWindowId: number): ITerminalWindowTransfer | undefined {
		for (const pending of this.pending.values()) {
			if (pending.targetWindowId !== targetWindowId || pending.claimed) continue;
			if (!this.validWindows(pending)) {
				this.finish(pending, new Error('Terminal transfer window changed'));
				continue;
			}
			pending.claimed = true;
			return pending.transfer;
		}
		return undefined;
	}

	complete(targetWindowId: number, result: ITerminalWindowTransferResult): void {
		const pending = this.pending.get(result.id);
		if (!pending || pending.targetWindowId !== targetWindowId || !pending.claimed)
			throw new Error('Terminal transfer is not owned by this window');
		if (!this.validWindows(pending)) {
			this.finish(pending, new Error('Terminal transfer window changed'));
			throw new Error('Terminal transfer window changed');
		}
		if (
			result.lease &&
			(result.lease.terminalId !== pending.transfer.lease.terminalId ||
				result.lease.dirId !== pending.transfer.lease.dirId)
		) {
			throw new Error('Terminal rollback lease belongs to another process');
		}
		this.finish(pending, result);
	}

	resetWindow(windowId: number): void {
		for (const pending of [...this.pending.values()]) {
			if (pending.targetWindowId === windowId || (pending.sourceWindowId === windowId && !pending.claimed)) {
				this.finish(pending, new Error('Terminal transfer window closed or reloaded'));
			} else if (pending.sourceWindowId === windowId) {
				// Once claimed, only the target may finish. Source teardown must not
				// turn a successful PTY attachment into a failed transfer/cleanup.
				pending.sourceReleased = true;
			}
		}
	}

	private async offer(pending: PendingTerminalTransfer, selectedWindowId: number | undefined): Promise<void> {
		const targetWindowId = selectedWindowId ?? (await this.host.openWindow(pending.sourceWindowId));
		if (this.pending.get(pending.transfer.id) !== pending) return;
		const targetBusy = [...this.pending.values()].some(
			other =>
				other !== pending &&
				(other.sourceWindowId === targetWindowId || other.targetWindowId === targetWindowId),
		);
		if (targetBusy) throw new Error('Terminal target window already has a pending transfer');
		pending.targetWindowId = targetWindowId;
		if (targetWindowId === pending.sourceWindowId || !this.validWindows(pending)) {
			throw new Error('Terminal transfer requires the same workspace and execution host');
		}
		this.host.getWindow(targetWindowId)!.requestTransfer();
	}

	private validWindows(pending: PendingTerminalTransfer): boolean {
		const source = this.host.getWindow(pending.sourceWindowId);
		const target = pending.targetWindowId === undefined ? undefined : this.host.getWindow(pending.targetWindowId);
		const matches = (window: TerminalTransferWindow | undefined): boolean =>
			!!window &&
			window.workspaceId === pending.workspaceId &&
			window.remoteAuthority === pending.remoteAuthority;
		return matches(target) && ((pending.sourceReleased && pending.claimed) || matches(source));
	}

	private finish(pending: PendingTerminalTransfer, outcome: ITerminalWindowTransferResult | Error): void {
		if (this.pending.get(pending.transfer.id) !== pending) return;
		this.pending.delete(pending.transfer.id);
		clearTimeout(pending.timer);
		if (outcome instanceof Error) pending.reject(outcome);
		else pending.resolve(outcome);
	}
}
