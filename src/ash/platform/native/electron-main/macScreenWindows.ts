import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SCREENSHOT_MAX_BYTES } from '../common/native.js';
import type { INativeAppWindow } from '../common/native.js';
import { validateAppWindow } from '../common/nativeHost.js';

const execute = promisify(execFile);

/** Core Graphics supplies stacking order and windows on other Spaces without Accessibility access. */
export async function getMacScreenWindows(): Promise<readonly INativeAppWindow[]> {
	const script = `ObjC.import('CoreGraphics');
		function run(argv) {
			const entries = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
			return JSON.stringify(entries.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowOwnerPID !== Number(argv[0])
				&& w.kCGWindowAlpha > 0 && w.kCGWindowBounds.Width > 1 && w.kCGWindowBounds.Height > 1)
				.sort((a, b) => Number(!!b.kCGWindowIsOnscreen) - Number(!!a.kCGWindowIsOnscreen))
				.map(w => ({sourceId: 'window:' + w.kCGWindowNumber + ':0', title: w.kCGWindowName || w.kCGWindowOwnerName || ''})));
		}`;
	const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(process.pid)], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
	const windows: unknown = JSON.parse(stdout);
	if (!Array.isArray(windows) || windows.length > 10000) {
		throw new TypeError('Invalid macOS window list');
	}
	return windows.map(validateAppWindow);
}

/** A private temporary directory prevents another process from substituting the output file. */
export async function captureMacWindow(sourceId: string): Promise<Uint8Array> {
	const directory = await mkdtemp(join(tmpdir(), 'ash-window-capture-'));
	try {
		const file = join(directory, 'window.png');
		await execute('/usr/sbin/screencapture', ['-x', '-o', '-t', 'png', '-l', sourceId.split(':')[1], file], { timeout: 5000 });
		if ((await stat(file)).size > SCREENSHOT_MAX_BYTES) {
			throw new RangeError('Application window screenshot is too large');
		}
		return new Uint8Array(await readFile(file));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
