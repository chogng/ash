import { app, shell } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeExternalUrl, type IExternalOpener, type IImageOpeningApplication, type ImageOpenExtension } from '../common/opener.js';

/** Electron shell adapter for validated external URLs. */
export class ElectronOpenerService implements IExternalOpener {
	constructor(private readonly windowsImageOpener: string | undefined) { }

	async openExternal(target: string): Promise<boolean> {
		await shell.openExternal(normalizeExternalUrl(target));
		return true;
	}

	async listImageOpeningApplications(extension: ImageOpenExtension): Promise<readonly IImageOpeningApplication[]> {
		if (process.platform === 'win32') return this.listWindowsImageApplications(extension);
		if (process.platform !== 'darwin') return [];
		const directory = await mkdtemp(join(app.getPath('temp'), 'ash-preview-types-'));
		try {
			const target = join(directory, `Image.${extension}`);
			await writeFile(target, '', { mode: 0o600 });
			return (await findMacImageApplications(target, true)).map(({ id, name, isDefault, icon }) => ({ id, name, isDefault, icon }));
		} finally {
			await rm(directory, { recursive: true, force: true }).catch(() => { });
		}
	}

	private async listWindowsImageApplications(extension: ImageOpenExtension): Promise<readonly IImageOpeningApplication[]> {
		if (!this.windowsImageOpener) return [];
		const { stdout } = await runFile(this.windowsImageOpener, ['list', extension], { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true });
		const applications: unknown = JSON.parse(stdout);
		if (!Array.isArray(applications)) throw new TypeError('Invalid system application list');
		const result: IImageOpeningApplication[] = [];
		for (const application of applications) {
			if (!application || typeof application.name !== 'string' || !application.name.trim()
				|| typeof application.isDefault !== 'boolean'
				|| !(isWindowsApplicationId(application.id) || application.id === 'default' && application.isDefault)) continue;
			result.push({
				id: application.id, name: application.name, isDefault: application.isDefault, icon: pngIcon(application.icon),
			});
		}
		return result;
	}

	async openImage({ bytes, extension, applicationId }: LocalImage): Promise<void> {
		const directory = await mkdtemp(join(app.getPath('temp'), 'ash-preview-'));
		try {
			const target = join(directory, `Image.${extension}`);
			await writeFile(target, bytes, { mode: 0o600 });
			if (applicationId === undefined) {
				const error = await shell.openPath(target);
				if (error) throw new Error(error);
			} else if (process.platform === 'win32') {
				if (!this.windowsImageOpener) throw new Error('Windows image application selection is unavailable');
				await runFile(this.windowsImageOpener, ['open', target, applicationId], { timeout: 10_000, windowsHide: true });
			} else {
				const application = (await findMacImageApplications(target)).find(candidate => candidate.id === applicationId);
				if (!application) throw new Error('The selected application is no longer available for this image');
				await runFile('/usr/bin/open', ['-a', application.path, target], { timeout: 10_000 });
			}
			retainPreview(directory);
		} catch (error) {
			await rm(directory, { recursive: true, force: true }).catch(() => { });
			throw error;
		}
	}
}

interface LocalImage { readonly bytes: Uint8Array; readonly extension: ImageOpenExtension; readonly applicationId?: string; }

export function validateImageOpenExtension(value: unknown): ImageOpenExtension {
	if (value === 'png' || value === 'jpg' || value === 'gif' || value === 'webp') return value;
	throw new TypeError('Unsupported image format');
}

export function validateImageOpenRequest(value: unknown): LocalImage {
	if (!value || typeof value !== 'object' || !('bytes' in value) || Object.keys(value).some(key => key !== 'bytes' && key !== 'applicationId')) {
		throw new TypeError('Invalid image open request');
	}
	const applicationId = 'applicationId' in value ? value.applicationId : undefined;
	if (applicationId !== undefined && !(process.platform === 'darwin' && isBundleId(applicationId)
		|| process.platform === 'win32' && isWindowsApplicationId(applicationId))) {
		throw new TypeError('Invalid image application');
	}
	return { ...validateLocalImage(value.bytes), applicationId };
}

/** Choose the system file association from bytes. The renderer never supplies a path. */
function validateLocalImage(bytes: unknown): LocalImage {
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

const runFile = promisify(execFile);

function isBundleId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9.-]{1,255}$/iu.test(value);
}

function isWindowsApplicationId(value: unknown): value is string {
	return typeof value === 'string' && /^win-[a-f0-9]{64}$/u.test(value);
}

function pngIcon(icon: unknown): string | undefined {
	return typeof icon === 'string' && icon.length <= 48 * 1024 && icon.startsWith('iVBORw0KGgo')
		? `data:image/png;base64,${icon}` : undefined;
}

async function findMacImageApplications(file: string, includeIcons = false): Promise<readonly (IImageOpeningApplication & { readonly path: string; })[]> {
	const { stdout } = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
ObjC.import('AppKit');
function applicationIcon(workspace, path) {
	try {
		const image = $.NSImage.alloc.initWithSize($.NSMakeSize(18, 18));
		image.lockFocus;
		try {
			workspace.iconForFile(path).drawInRectFromRectOperationFraction(
				$.NSMakeRect(0, 0, 18, 18), $.NSMakeRect(0, 0, 0, 0), $.NSCompositingOperationSourceOver, 1);
		} finally {
			image.unlockFocus;
		}
		const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
		const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
		return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
	} catch {
		return undefined;
	}
}
function run(args) {
	const workspace = $.NSWorkspace.sharedWorkspace;
	const file = $.NSURL.fileURLWithPath(args[0]);
	const urls = workspace.URLsForApplicationsToOpenURL(file);
	const defaultURL = workspace.URLForApplicationToOpenURL(file);
	const defaultPath = defaultURL.isNil() ? undefined : ObjC.unwrap(defaultURL.path);
	const applications = [];
	for (let i = 0; i < urls.count; i++) {
		const url = urls.objectAtIndex(i);
		const path = ObjC.unwrap(url.path);
		const id = ObjC.unwrap($.NSBundle.bundleWithURL(url).bundleIdentifier);
		// These apps register image formats for attachments or document editing.
		if (id === 'com.anthropic.claudefordesktop' || id === 'org.libreoffice.script') continue;
		const name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path));
		const icon = args[1] === 'icons' ? applicationIcon(workspace, url.path) : undefined;
		applications.push({ id, path, name, isDefault: path === defaultPath, icon });
	}
	return JSON.stringify(applications);
}`, file, includeIcons ? 'icons' : 'names'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
	const applications: unknown = JSON.parse(stdout);
	if (!Array.isArray(applications)) throw new TypeError('Invalid system application list');
	const unique = new Map<string, IImageOpeningApplication & { path: string; }>();
	for (const application of applications) {
		if (application && isBundleId(application.id) && typeof application.path === 'string' && application.path.startsWith('/') &&
			typeof application.name === 'string' && (!unique.has(application.id) || application.isDefault === true)) {
			unique.set(application.id, {
				id: application.id, path: application.path, name: application.name.replace(/\.app$/iu, ''), isDefault: application.isDefault === true,
				icon: pngIcon(application.icon),
			});
		}
	}
	return [...unique.values()];
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
