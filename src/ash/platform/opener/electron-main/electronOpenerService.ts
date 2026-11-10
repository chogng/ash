import { app, shell } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeExternalUrl, type IExternalOpener } from '../common/opener.js';

/** Electron shell adapter for validated external URLs. */
export class ElectronOpenerService implements IExternalOpener {
	async openExternal(target: string): Promise<boolean> {
		await shell.openExternal(normalizeExternalUrl(target));
		return true;
	}

	async openImageInDefaultApp({ bytes, extension }: LocalImage): Promise<void> {
		const directory = await mkdtemp(join(app.getPath('temp'), 'ash-preview-'));
		try {
			const target = join(directory, `Image.${extension}`);
			await writeFile(target, bytes, { mode: 0o600 });
			const error = await shell.openPath(target);
			if (error) throw new Error(error);
			retainPreview(directory);
		} catch (error) {
			await rm(directory, { recursive: true, force: true }).catch(() => { });
			throw error;
		}
	}
}

interface LocalImage { readonly bytes: Uint8Array; readonly extension: 'png' | 'jpg' | 'gif' | 'webp'; }

/** Choose the system file association from bytes. The renderer never supplies a path. */
export function validateLocalImage(bytes: unknown): LocalImage {
	if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > 20 * 1024 * 1024) {
		throw new TypeError('Invalid image bytes');
	}
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { bytes, extension: 'png' };
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, extension: 'jpg' };
	const header = String.fromCharCode(...bytes.subarray(0, 12));
	if (/^GIF8[79]a/u.test(header)) return { bytes, extension: 'gif' };
	if (header.startsWith('RIFF') && header.endsWith('WEBP')) return { bytes, extension: 'webp' };
	throw new TypeError('Unsupported image format');
}

const previewDirectories = new Set<string>();
let observingQuit = false;
function retainPreview(directory: string): void {
	previewDirectories.add(directory);
	if (!observingQuit) {
		observingQuit = true;
		app.once('will-quit', () => {
			for (const path of previewDirectories) {
				try { rmSync(path, { recursive: true, force: true }); } catch { }
			}
			previewDirectories.clear();
		});
	}
	// The external viewer can read or reopen the file after shell.openPath resolves.
	setTimeout(() => {
		void rm(directory, { recursive: true, force: true }).then(() => previewDirectories.delete(directory), () => { });
	}, 60 * 60 * 1000).unref();
}
