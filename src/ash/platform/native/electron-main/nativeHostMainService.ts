import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_PIXELS, type DesktopScreenshot } from '../common/native.js';
import type { BrowserWindow } from 'electron/main';
import type { IRectangle } from '../../window/common/window.js';
import { VSBuffer } from '../../../base/common/buffer.js';

/** Main owns the sender's capture target and converts CSS coordinates to window DIPs. */
export async function getScreenshot(window: BrowserWindow, rect?: IRectangle): Promise<VSBuffer | undefined> {
	if (window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
	const zoom = window.webContents.getZoomFactor();
	const bounds = window.getContentBounds();
	if (rect && ((rect.x + rect.width) * zoom > bounds.width + 1 || (rect.y + rect.height) * zoom > bounds.height + 1)) {
		throw new RangeError('Screenshot rectangle is outside the window');
	}
	// Round both edges onto the same DIP grid; outward rounding adds pixels at fractional zoom.
	const clip = rect ? {
		x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom),
		width: Math.max(1, Math.round((rect.x + rect.width) * zoom) - Math.round(rect.x * zoom)),
		height: Math.max(1, Math.round((rect.y + rect.height) * zoom) - Math.round(rect.y * zoom)),
	} : undefined;
	const image = await window.webContents.capturePage(clip);
	if (window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
	const bytes = image.toPNG();
	if (image.isEmpty() || bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Screenshot image is empty or too large');
	return VSBuffer.wrap(new Uint8Array(bytes));
}

/** Acquires display pixels only; the workbench owns selection, overlays and output actions. */
export async function getDesktopScreenshots(): Promise<readonly DesktopScreenshot[]> {
	const { desktopCapturer, screen } = await import('electron/main');
	const displays = screen.getAllDisplays();
	const width = Math.max(...displays.map(display => Math.ceil(display.size.width * display.scaleFactor)));
	const height = Math.max(...displays.map(display => Math.ceil(display.size.height * display.scaleFactor)));
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > SCREENSHOT_MAX_PIXELS) throw new Error('ScreenshotTooLarge');
	// Freeze every display before the caller can show overlays, including mixed-DPI desktops.
	const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false }).catch(error => {
		throw new Error('ScreenshotUnavailable', { cause: error });
	});
	return displays.map(display => {
		const source = sources.find(candidate => candidate.display_id === String(display.id));
		// Enumeration order is not a reliable display identity.
		if (!source || source.thumbnail.isEmpty()) throw new Error('ScreenshotUnavailable');
		const bytes = source.thumbnail.toPNG();
		const size = source.thumbnail.getSize();
		if (!bytes.byteLength || bytes.byteLength > SCREENSHOT_MAX_BYTES || size.width * size.height > SCREENSHOT_MAX_PIXELS) throw new Error('ScreenshotTooLarge');
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
