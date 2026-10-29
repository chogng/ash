import koffi from 'koffi';
import type { Point, Rectangle, Size } from 'electron';

/** Use the recording-list controls when readable; otherwise keep the card near Settings. */
export function getPermissionGuidePosition(
	settings: Rectangle,
	size: Size,
	area: Rectangle,
	recordingList?: Rectangle,
): Point {
	const gap = 8;
	const clampX = (x: number): number => Math.round(Math.max(area.x, Math.min(x, area.x + area.width - size.width)));
	const clampY = (y: number): number => Math.round(Math.max(area.y, Math.min(y, area.y + area.height - size.height)));
	if (
		recordingList &&
		recordingList.y + recordingList.height >= settings.y &&
		recordingList.y + recordingList.height <= settings.y + settings.height &&
		recordingList.y + recordingList.height + gap + size.height <= area.y + area.height
	) {
		return { x: clampX(recordingList.x), y: Math.round(recordingList.y + recordingList.height + gap) };
	}
	if (settings.y + settings.height + gap + size.height <= area.y + area.height) {
		return {
			x: clampX(settings.x + (settings.width - size.width) / 2),
			y: clampY(settings.y + settings.height + gap),
		};
	}
	if (settings.x + settings.width + gap + size.width <= area.x + area.width) {
		return { x: clampX(settings.x + settings.width + gap), y: clampY(settings.y + settings.height - size.height) };
	}
	if (settings.x - gap - size.width >= area.x) {
		return { x: clampX(settings.x - gap - size.width), y: clampY(settings.y + settings.height - size.height) };
	}
	if (settings.y - gap - size.height >= area.y) {
		return { x: clampX(settings.x + (settings.width - size.width) / 2), y: clampY(settings.y - gap - size.height) };
	}
	// With no free edge, stay near the sidebar instead of covering the recording switches.
	return { x: area.x, y: clampY(area.y + area.height - size.height) };
}

interface SettingsWindow {
	readonly bounds: Rectangle;
	readonly pid: number;
}

const readSettingsWindow = process.platform === 'darwin' ? createWindowReader() : () => undefined;
const readRecordingList = process.platform === 'darwin' ? createControlReader() : () => undefined;

/** Reads only window geometry and process identity; no pixels, titles or Accessibility access. */
export function getSystemSettingsWindowInfo(): SettingsWindow | undefined {
	return readSettingsWindow();
}

/** Reads only structural roles and geometry, and never requests Accessibility permission. */
export function getScreenRecordingListBounds(window: SettingsWindow): Rectangle | undefined {
	return readRecordingList(window);
}

function createWindowReader(): () => SettingsWindow | undefined {
	const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
	const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
	const proc = koffi.load('/usr/lib/libproc.dylib');
	const createKey = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)');
	const release = cf.func('void CFRelease(void *value)');
	const list = cg.func('void *CGWindowListCopyWindowInfo(uint32_t options, uint32_t relativeToWindow)');
	const count = cf.func('long CFArrayGetCount(void *array)');
	const at = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
	const get = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
	const number = cf.func('bool CFNumberGetValue(void *value, int type, _Out_ double *output)');
	const pidPath = proc.func('int proc_pidpath(int pid, _Out_ uint8_t *buffer, uint32_t size)');
	const names = ['kCGWindowLayer', 'kCGWindowOwnerPID', 'kCGWindowBounds', 'X', 'Y', 'Width', 'Height'];
	return () => {
		const keys = names.map(name => createKey(null, name, 0x08000100));
		// On-screen, non-desktop window metadata is available while screen recording is denied.
		const windows = list(1 | 16, 0);
		try {
			if (!windows || keys.some(key => !key)) {
				return undefined;
			}
			const length = Number(count(windows));
			if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) {
				return undefined;
			}
			const value = (dictionary: unknown, index: number): number | undefined => {
				const ref = get(dictionary, keys[index]);
				if (!ref) {
					return undefined;
				}
				const output = [0];
				return number(ref, 13, output) && Number.isFinite(output[0]) ? output[0] : undefined;
			};
			const processes = new Map<number, boolean>();
			let bounds: Rectangle | undefined;
			let selectedPid = 0;
			for (let index = 0; index < length; index++) {
				const window = at(windows, index);
				if (!window || value(window, 0) !== 0) {
					continue;
				}
				const pid = value(window, 1);
				if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
					continue;
				}
				if (!processes.has(pid)) {
					const path = Buffer.alloc(4096);
					const size = pidPath(pid, path, path.length);
					processes.set(
						pid,
						size > 0 &&
							size <= path.length &&
							path
								.toString('utf8', 0, size)
								.replace(/\0.*$/s, '')
								.endsWith('/System Settings.app/Contents/MacOS/System Settings'),
					);
				}
				if (!processes.get(pid)) {
					continue;
				}
				const rect = get(window, keys[2]);
				if (!rect) {
					continue;
				}
				const x = value(rect, 3),
					y = value(rect, 4),
					width = value(rect, 5),
					height = value(rect, 6);
				if (
					x === undefined ||
					y === undefined ||
					width === undefined ||
					height === undefined ||
					Math.abs(x) > 1_000_000 ||
					Math.abs(y) > 1_000_000 ||
					width < 480 ||
					height < 300 ||
					width > 1_000_000 ||
					height > 1_000_000
				) {
					continue;
				}
				// The main window is larger than consent alerts and transient file panels.
				if (!bounds || width * height > bounds.width * bounds.height) {
					bounds = { x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) };
					selectedPid = pid;
				}
			}
			return bounds ? { bounds, pid: selectedPid } : undefined;
		} finally {
			if (windows) {
				release(windows);
			}
			for (const key of keys) {
				if (key) {
					release(key);
				}
			}
		}
	};
}

function createControlReader(): (window: SettingsWindow) => Rectangle | undefined {
	const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
	const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
	const trusted = ax.func('bool AXIsProcessTrusted(void)');
	const application = ax.func('void *AXUIElementCreateApplication(int pid)');
	const copy = ax.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)');
	const timeout = ax.func('int AXUIElementSetMessagingTimeout(void *element, float seconds)');
	const createKey = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)');
	const release = cf.func('void CFRelease(void *value)');
	const count = cf.func('long CFArrayGetCount(void *array)');
	const at = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
	const text = cf.func('bool CFStringGetCString(void *value, _Out_ uint8_t *buffer, long size, uint32_t encoding)');
	const pair = koffi.struct({ first: 'double', second: 'double' });
	const decode = ax.func('AXValueGetValue', 'bool', ['void *', 'int', koffi.out(koffi.pointer(pair))]);
	return window => {
		if (!trusted()) {
			return undefined;
		}
		const keys = new Map(
			['AXWindows', 'AXChildren', 'AXRole', 'AXPosition', 'AXSize'].map(name => [
				name,
				createKey(null, name, 0x08000100),
			]),
		);
		const app = application(window.pid);
		const deadline = Date.now() + 100;
		let visited = 0;
		const value = (element: unknown, key: string): unknown => {
			if (Date.now() > deadline) {
				return undefined;
			}
			const output = [null];
			return copy(element, keys.get(key), output) === 0 ? output[0] : undefined;
		};
		const role = (element: unknown): string => {
			const ref = value(element, 'AXRole');
			if (!ref) {
				return '';
			}
			try {
				const buffer = Buffer.alloc(128);
				return text(ref, buffer, buffer.length, 0x08000100)
					? buffer.toString('utf8').replace(/\0.*$/s, '')
					: '';
			} finally {
				release(ref);
			}
		};
		const point = (element: unknown, key: string, type: number): readonly number[] | undefined => {
			const ref = value(element, key);
			if (!ref) {
				return undefined;
			}
			try {
				const output = { first: 0, second: 0 };
				return decode(ref, type, output) && Number.isFinite(output.first) && Number.isFinite(output.second)
					? [output.first, output.second]
					: undefined;
			} finally {
				release(ref);
			}
		};
		const bounds = (element: unknown): Rectangle | undefined => {
			const position = point(element, 'AXPosition', 1),
				size = point(element, 'AXSize', 2);
			if (
				!position ||
				!size ||
				Math.abs(position[0]!) > 1_000_000 ||
				Math.abs(position[1]!) > 1_000_000 ||
				size[0]! <= 0 ||
				size[1]! <= 0 ||
				size[0]! > 1_000_000 ||
				size[1]! > 1_000_000
			) {
				return undefined;
			}
			return { x: position[0]!, y: position[1]!, width: size[0]!, height: size[1]! };
		};
		const arrayLength = (array: unknown): number => {
			const length = Number(count(array));
			return Number.isSafeInteger(length) && length >= 0 && length <= 2_000 ? length : 0;
		};
		const lists: Rectangle[] = [];
		const visit = (element: unknown, depth: number): void => {
			if (++visited > 256 || depth > 20 || Date.now() > deadline) {
				return;
			}
			timeout(element, 0.03);
			const kind = role(element);
			// Permission entries and their names are irrelevant to positioning the controls.
			if (['AXRow', 'AXOutline', 'AXTable', 'AXList', 'AXToolbar'].includes(kind)) {
				return;
			}
			const children = value(element, 'AXChildren');
			if (!children) {
				return;
			}
			try {
				const elements = Array.from({ length: arrayLength(children) }, (_, index) => at(children, index));
				if (kind === 'AXGroup' && elements.length === 3) {
					const roles = elements.map(child => {
						timeout(child, 0.03);
						return role(child);
					});
					if (roles[0] === 'AXScrollArea' && roles[1] === 'AXButton' && roles[2] === 'AXButton') {
						const rect = bounds(element),
							add = bounds(elements[1]),
							remove = bounds(elements[2]);
						if (
							rect &&
							add &&
							remove &&
							rect.width >= 200 &&
							add.y >= rect.y + rect.height / 2 &&
							remove.y >= add.y - 8
						) {
							lists.push(rect);
						}
						return;
					}
				}
				for (const child of elements) {
					visit(child, depth + 1);
				}
			} finally {
				release(children);
			}
		};
		try {
			if (!app || [...keys.values()].some(key => !key)) {
				return undefined;
			}
			timeout(app, 0.03);
			const windows = value(app, 'AXWindows');
			if (!windows) {
				return undefined;
			}
			try {
				for (let index = 0; index < arrayLength(windows); index++) {
					const candidate = at(windows, index);
					timeout(candidate, 0.03);
					const rect = bounds(candidate);
					if (
						rect &&
						Math.abs(rect.x - window.bounds.x) <= 2 &&
						Math.abs(rect.y - window.bounds.y) <= 2 &&
						Math.abs(rect.width - window.bounds.width) <= 2 &&
						Math.abs(rect.height - window.bounds.height) <= 2
					) {
						visit(candidate, 0);
						break;
					}
				}
			} finally {
				release(windows);
			}
			// Screen recording has a second system-audio list. Do not anchor to a lone, unrelated permission table.
			lists.sort((left, right) => left.y - right.y);
			const first = lists[0],
				second = lists[1];
			return first && second && Math.abs(first.x - second.x) <= 2 && Math.abs(first.width - second.width) <= 2
				? first
				: undefined;
		} finally {
			if (app) {
				release(app);
			}
			for (const key of keys.values()) {
				if (key) {
					release(key);
				}
			}
		}
	};
}
