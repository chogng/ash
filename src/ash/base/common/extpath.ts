import { isWindows } from './platform.js';

/** Checks one decoded filesystem name without interpreting it as a path. */
export function isValidBasename(name: string | null | undefined, isWindowsOS: boolean = isWindows): boolean {
	if (!name || name === '.' || name === '..' || /[\/\u0000]/.test(name)) {
		return false;
	}
	if (!isWindowsOS) {
		return true;
	}
	if (/[\\<>:"|?*\u0001-\u001f]/.test(name) || /[. ]$/.test(name)) {
		return false;
	}
	// Windows device aliases remain reserved when followed by an extension.
	const stem = name.split('.')[0].trimEnd().toUpperCase();
	return !/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/.test(stem);
}
