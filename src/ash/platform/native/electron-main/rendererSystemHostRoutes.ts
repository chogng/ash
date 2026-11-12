import type { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { collectElectronMemory } from '../../memory/electron-main/electronMemoryCollector.js';
import { URI } from '../../../base/common/uri.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { Notification, systemPreferences, type BrowserWindow } from 'electron/main';
import { ElectronMainClipboardService } from '../../clipboard/electron-main/electronMainClipboardService.js';
import { type ElectronOpenerService, validateImageOpenExtension, validateImageOpenRequest } from '../../opener/electron-main/electronOpenerService.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { DialogRequest } from '../../dialogs/common/dialogs.js';
import { NATIVE_HOST_IMAGE_APPLICATIONS_CHANNEL, NATIVE_HOST_OPEN_IMAGE_CHANNEL, validateScreenshotRectangle } from '../common/nativeHost.js';
import { getScreenshot } from './nativeHostMainService.js';
import { nativeToastRoutes, type INativeToast } from './nativeToast.js';
import { REQUEST_MICROPHONE_ACCESS_CHANNEL, type IToastOptions } from '../common/native.js';
import type { DirectoryPermissionRequest } from '../../workspace/common/workspaceTrust.js';
import { validateDirectoryPermissionRequest } from '../../workspace/common/workspaceIpc.js';

let windowsToastActivations: Map<string, () => void> | undefined;

function toastText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '')
		.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function createNativeToast({ title, body }: IToastOptions): INativeToast | undefined {
	if (!Notification.isSupported()) return undefined;
	if (process.platform !== 'win32') return { notification: new Notification({ title, body }) };

	// Notification Center can activate a toast after its WinRT banner has timed out.
	// Give the OS callback an opaque key that is valid only for this live request.
	if (!windowsToastActivations) {
		windowsToastActivations = new Map();
		Notification.handleActivation(details => {
			if (details.type === 'click') windowsToastActivations?.get(details.arguments)?.();
		});
	}
	const activations = windowsToastActivations;
	const key = `ash-toast:${generateUuid()}`;
	const text = [title, body].filter((value): value is string => value !== undefined).map(value => `<text>${toastText(value)}</text>`).join('');
	const toastXml = `<toast launch="${key}" activationType="foreground"><visual><binding template="ToastGeneric">${text}</binding></visual></toast>`;
	return {
		notification: new Notification({ title, body, toastXml }),
		onDidActivate: listener => {
			activations.set(key, listener);
			return toDisposable(() => { activations.delete(key); });
		},
	};
}

export function rendererSystemHostRoutes(
	window: BrowserWindow,
	auxiliaryWindows: IAuxiliaryWindowsMainService,
	opener: ElectronOpenerService,
	directoryPermissionPrompt?: (request: DirectoryPermissionRequest) => DialogRequest,
): readonly IpcRoute<unknown, unknown>[] {
	const clipboard = new ElectronMainClipboardService(window);
	const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 1_000_000) { throw new Error('Invalid host text'); } return value; };
	const clipboardType = (value: unknown): 'clipboard' | 'selection' | undefined => {
		if (value !== undefined && value !== 'clipboard' && value !== 'selection') {
			throw new TypeError('Invalid clipboard type');
		}
		return value;
	};
	const clipboardWrite = (value: unknown): { text: string; type: 'clipboard' | 'selection' | undefined; } => {
		if (typeof value === 'string') {
			return { text: text(value), type: undefined };
		}
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'text' && key !== 'type') || !('text' in value)) {
			throw new TypeError('Invalid clipboard text write');
		}
		return { text: text(value.text), type: clipboardType('type' in value ? value.type : undefined) };
	};
	const resourceWrite = (value: unknown): { resources: string[]; operation: 'copy' | 'move'; } => {
		if (!value || typeof value !== 'object' || !('resources' in value) || !('operation' in value)) throw new Error('Invalid clipboard resources');
		const { resources, operation } = value;
		if (!Array.isArray(resources) || resources.length > 1024 || !resources.every(item => typeof item === 'string' && item.length <= 8192) || (operation !== 'copy' && operation !== 'move')) throw new Error('Invalid clipboard resources');
		return { resources, operation };
	};
	return [
		{
			channel: REQUEST_MICROPHONE_ACCESS_CHANNEL,
			validate: value => { if (value !== undefined) throw new TypeError('Unexpected microphone permission arguments'); },
			invoke: () => {
				if (process.platform === 'darwin') return systemPreferences.askForMediaAccess('microphone');
				if (process.platform !== 'win32') return true;
				const status = systemPreferences.getMediaAccessStatus('microphone');
				return status !== 'denied' && status !== 'restricted';
			},
		},
		...nativeToastRoutes(
			createNativeToast,
			reset => {
				window.webContents.once('destroyed', reset);
				window.webContents.on('render-process-gone', reset);
				window.webContents.on('did-start-navigation', event => {
					if (event.isMainFrame && !event.isSameDocument) reset();
				});
			},
			// Chromium can retain DOM focus while the native window is minimized.
			() => (!window.isMinimized() && window.isFocused()) || auxiliaryWindows.getWindows().some(candidate =>
				candidate.parentId === window.id && !candidate.win.isMinimized() && candidate.win.isFocused()),
		),
		{ channel: 'ash:memory:collect', validate: value => { if (value !== undefined) { throw new Error('Unexpected memory collection arguments'); } }, invoke: () => collectElectronMemory(window) },
		{ channel: 'ash:host:openExternal', validate: text, invoke: value => opener.openExternal(value as string) },
		{
			channel: NATIVE_HOST_OPEN_IMAGE_CHANNEL,
			validate: validateImageOpenRequest,
			invoke: value => opener.openImage(value as ReturnType<typeof validateImageOpenRequest>),
		},
		{
			channel: NATIVE_HOST_IMAGE_APPLICATIONS_CHANNEL,
			validate: validateImageOpenExtension,
			invoke: value => opener.listImageOpeningApplications(value as ReturnType<typeof validateImageOpenExtension>),
		},
		{
			channel: 'ash:host:triggerPaste',
			validate: value => {
				if (value === undefined) return undefined;
				if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('windowName' in value)
					|| typeof value.windowName !== 'string' || !/^ash-auxiliary-[0-9a-f-]{36}$/.test(value.windowName)) {
					throw new TypeError('Invalid paste target');
				}
				return value.windowName;
			},
			invoke: async value => {
				if (value === undefined) return clipboard.triggerPaste(window.id);
				// A renderer can select only a live auxiliary window registered under its own workbench.
				const target = auxiliaryWindows.getWindows().find(candidate => candidate.parentId === window.id && candidate.win.webContents.mainFrame.name === value);
				if (!target) throw new Error('The paste target window is unavailable');
				await new ElectronMainClipboardService(target.win).triggerPaste(target.id);
			},
		},
		{ channel: 'ash:host:readClipboard', validate: clipboardType, invoke: value => clipboard.readText(value as ReturnType<typeof clipboardType>) },
		{ channel: 'ash:host:readClipboardData', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.read() },
		{ channel: 'ash:host:readClipboardImage', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.readImage() },
		{
			channel: 'ash:host:writeClipboardImage',
			validate: value => {
				if (!(value instanceof Uint8Array) || value.length < 8 ||
					![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => value[index] === byte)) {
					throw new TypeError('Image clipboard requires PNG bytes');
				}
				return value;
			},
			invoke: value => clipboard.writeImage(value as Uint8Array),
		},
		{
			channel: 'ash:host:screenshot', validate: validateScreenshotRectangle, invoke: async value => {
				// The trusted router binds this route to its sender; another window can never be chosen by renderer input.
				return (await getScreenshot(window, value as ReturnType<typeof validateScreenshotRectangle>))?.buffer;
			}
		},
		{ channel: 'ash:host:readFindClipboard', validate: value => { if (value !== undefined) throw new Error('Unexpected find clipboard arguments'); }, invoke: () => clipboard.readFindText() },
		{ channel: 'ash:host:writeFindClipboard', validate: text, invoke: value => clipboard.writeFindText(value as string) },
		{
			channel: 'ash:host:writeClipboard', validate: clipboardWrite, invoke: value => {
				const { text, type } = value as ReturnType<typeof clipboardWrite>;
				return clipboard.writeText(text, type);
			}
		},
		{
			channel: 'ash:host:writeClipboardHtml',
			validate: value => {
				if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
					|| !('text' in value) || !('html' in value) || typeof value.html !== 'string' || value.html.length > 16 * 1024 * 1024) {
					throw new TypeError('Invalid HTML clipboard write');
				}
				return { text: text(value.text), html: value.html };
			},
			invoke: value => {
				const { text, html } = value as { text: string; html: string; };
				return clipboard.writeTextWithHtml(text, Promise.resolve(html));
			},
		},
		{
			channel: 'ash:host:readClipboardResources', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: async () => {
				const { resources, operation } = await clipboard.readResources();
				return { resources: resources.map(resource => resource.toString()), operation };
			}
		},
		{
			channel: 'ash:host:writeClipboardResources', validate: resourceWrite, invoke: value => {
				const { resources, operation } = value as ReturnType<typeof resourceWrite>;
				return clipboard.writeResources(resources.map(uri => URI.parse(uri)), operation);
			}
		},
		{ channel: 'ash:host:hasClipboardResources', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.hasResources() },
		...(directoryPermissionPrompt ? [{
			channel: 'ash:host:directoryPermissionPrompt',
			validate: validateDirectoryPermissionRequest,
			invoke: (value: unknown) => directoryPermissionPrompt(value as DirectoryPermissionRequest),
		}] : []),
	];
}
