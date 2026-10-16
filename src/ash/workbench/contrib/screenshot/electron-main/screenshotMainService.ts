import type {
	GlobalKeybindingsMainService,
	IGlobalKeybindingOwner
} from '../../../../platform/globalKeybindings/electron-main/globalKeybindingsMainService.js';
import { ScreenshotCommandId } from '../common/screenshot.js';
import type { ScreenshotPermission } from '../common/screenshot.js';
import { shell } from 'electron';
import { basename, dirname } from 'node:path';
import { formatNlsMessage, localize2 } from '../../../../nls.js';
import { getDesktopScreenshots } from '../../../../platform/native/electron-main/nativeHostMainService.js';
import {
	app,
	BrowserWindow,
	clipboard,
	ClipboardItem,
	dialog,
	screen,
	systemPreferences,
	type WebPreferences,
	type Display
} from 'electron/main';
import { writeFile } from 'node:fs/promises';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	normalizeEntryUrl,
	type IpcRoute,
	type TrustedIpcRouter
} from '../../../../platform/ipc/electron-main/trustedIpcRouter.js';
import {
	SCREENSHOT_SHORTCUT_CHANNEL,
	SCREENSHOT_TRIGGER_CHANNEL,
	validateScreenshotShortcutRequest,
	type ScreenshotShortcutRequest,
	SCREENSHOT_PERMISSION_CHANNEL,
	validateScreenshotPermissionAction,
	SCREENSHOT_CAPTURE_CHANNEL,
	SCREENSHOT_CANCEL_CHANNEL,
	SCREENSHOT_COMPLETE_CHANNEL,
	SCREENSHOT_INITIALIZE_CHANNEL,
	SCREENSHOT_READY_CHANNEL,
	validateScreenshotCompletion,
	validateScreenshotId,
	validateScreenshotRequest,
	type ScreenshotCompletion,
	type ScreenshotRequest
} from '../common/screenshotProtocol.js';

interface ScreenshotWindowOptions {
	readonly entry: { readonly file: string; readonly url: string; readonly useDevelopmentUrl: boolean; };
	readonly webPreferences: WebPreferences;
	readonly router: TrustedIpcRouter;
	readonly localization: () => {
		readonly locale: string;
		readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
	};
}

interface Capture {
	readonly request: ScreenshotRequest;
	readonly resolve: (image: Uint8Array | undefined) => void;
	readonly reject: (error: unknown) => void;
	readonly lifetime: DisposableStore;
	windows: DisposableStore;
	readonly views: BrowserWindow[];
	generation: number;
	closing: boolean;
	completing: boolean;
}

// Only a manual capture owns desktop-wide overlays; window/AI capture never enters this service.
let activeCapture: ScreenshotMainService | undefined;

/** Workbench contribution owns manual overlay windows and explicit OS output actions. */
export class ScreenshotMainService extends Disposable {
	private capture: Capture | undefined;
	private readonly shortcutOwner: IGlobalKeybindingOwner;

	constructor(
		private readonly owner: BrowserWindow,
		private readonly options: ScreenshotWindowOptions,
		globalKeybindings: GlobalKeybindingsMainService
	) {
		super();
		this.shortcutOwner = this._register(
			globalKeybindings.createOwner(owner.id, () => {
				if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(SCREENSHOT_TRIGGER_CHANNEL);
			})
		);
		const webContents = owner.webContents;
		const cancel = (): void => {
			this.finish();
			if (owner.isDestroyed()) this.shortcutOwner.dispose();
			else this.shortcutOwner.update(undefined);
		};
		const navigating = (_event: unknown, _url: unknown, inPlace: boolean, mainFrame: boolean): void => {
			if (mainFrame && !inPlace) {
				this.finish();
				this.shortcutOwner.update(undefined);
			}
		};
		webContents.on('render-process-gone', cancel);
		webContents.on('did-start-navigation', navigating);
		owner.on('closed', cancel);
		this._register(
			toDisposable(() => {
				webContents.off('render-process-gone', cancel);
				webContents.off('did-start-navigation', navigating);
				owner.off('closed', cancel);
				this.finish();
			})
		);
	}

	routes(): readonly IpcRoute<unknown, unknown>[] {
		return [
			{
				channel: SCREENSHOT_SHORTCUT_CHANNEL,
				validate: validateScreenshotShortcutRequest,
				invoke: (value) => {
					const request = value as ScreenshotShortcutRequest;
					let available: boolean;
					if (request.global)
						available = !!request.accelerator && this.shortcutOwner.update({
							accelerator: request.accelerator,
							userSettingsLabel: request.label,
							commandId: ScreenshotCommandId
						});
					else {
						this.shortcutOwner.update(undefined);
						available =
							!!request.accelerator && this.shortcutOwner.check(request.accelerator, ScreenshotCommandId);
					}
					return { available, activeLabel: this.shortcutOwner.getBinding()?.userSettingsLabel ?? '' };
				}
			},
			{
				channel: SCREENSHOT_PERMISSION_CHANNEL,
				validate: validateScreenshotPermissionAction,
				invoke: async (value) => {
					if (value === 'status') return this.getPermission();
					if (!this.getPermission().canOpenSystemSettings)
						throw new Error('System screen capture settings are unavailable');
					if (value === 'open-settings') await this.openPermissionSettings();
					else shell.showItemInFolder(this.getPermission().applicationPath);
				}
			},
			{
				channel: SCREENSHOT_CAPTURE_CHANNEL,
				validate: validateScreenshotRequest,
				invoke: (value) => this.start(value as ScreenshotRequest)
			},
			{
				channel: SCREENSHOT_CANCEL_CHANNEL,
				validate: validateScreenshotId,
				invoke: (value) => {
					if (this.capture?.request.id === value) this.finish();
				}
			}
		];
	}

	private start(request: ScreenshotRequest): Promise<Uint8Array | undefined> {
		if (this.isDisposed || this.owner.isDestroyed()) return Promise.resolve(undefined);
		activeCapture?.finish();
		activeCapture = this;
		return new Promise((resolve, reject) => {
			const capture: Capture = {
				request,
				resolve,
				reject,
				lifetime: new DisposableStore(),
				windows: new DisposableStore(),
				views: [],
				generation: 0,
				closing: false,
				completing: false
			};
			this.capture = capture;
			const displaysChanged = (): void => {
				if (this.capture === capture) this.finish();
			};
			const displayMetricsChanged = (_event: unknown, _display: Display, metrics: string[]): void => {
				// Dock/menu visibility changes only workArea; frozen desktop coordinates remain valid.
				if (metrics.some((metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation'))
					displaysChanged();
			};
			screen.on('display-added', displaysChanged);
			screen.on('display-removed', displaysChanged);
			screen.on('display-metrics-changed', displayMetricsChanged);
			capture.lifetime.add(
				toDisposable(() => {
					screen.off('display-added', displaysChanged);
					screen.off('display-removed', displaysChanged);
					screen.off('display-metrics-changed', displayMetricsChanged);
				})
			);
			void this.open(capture).catch((error) => {
				if (this.capture === capture) this.finish(undefined, error);
			});
		});
	}

	private async open(capture: Capture): Promise<void> {
		const generation = ++capture.generation;
		if (this.needsScreenPermission()) {
			await this.showPermissionGuide(capture);
			return;
		}
		// An undetermined permission must reach the OS capture request once so macOS can ask for consent.
		const frames = await getDesktopScreenshots().catch(async (error) => {
			if (this.needsScreenPermission(true)) {
				await this.showPermissionGuide(capture);
				return undefined;
			}
			throw error;
		});
		if (!frames || this.capture !== capture || capture.generation !== generation || this.owner.isDestroyed())
			return;
		if (this.needsScreenPermission(true)) {
			await this.showPermissionGuide(capture);
			return;
		}
		const preferred = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
		const loaded: Promise<void>[] = [];
		for (const frame of frames) {
			const image = frame.image.buffer;
			const view = new BrowserWindow({
				...frame.bounds,
				frame: false,
				roundedCorners: false,
				transparent: false,
				resizable: false,
				movable: false,
				minimizable: false,
				maximizable: false,
				fullscreenable: false,
				hasShadow: false,
				show: false,
				skipTaskbar: true,
				alwaysOnTop: true,
				enableLargerThanScreen: true,
				webPreferences: {
					...this.options.webPreferences,
					partition: 'ash-screenshot',
					backgroundThrottling: false,
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true
				}
			});
			capture.views.push(view);
			view.setAlwaysOnTop(true, 'screen-saver');
			if (process.platform === 'darwin') view.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
			view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
			view.webContents.session.setPermissionCheckHandler(() => false);
			view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			view.webContents.on('will-navigate', (event) => event.preventDefault());
			const resources = capture.windows.add(new DisposableStore());
			let ready!: () => void;
			const rendered = new Promise<void>((resolve) => {
				ready = resolve;
			});
			resources.add(
				this.options.router.register(
					{
						webContents: view.webContents,
						allowedEntryUrls: new Set([normalizeEntryUrl(this.options.entry.url)])
					},
					[
						{
							channel: SCREENSHOT_INITIALIZE_CHANNEL,
							validate: noArguments,
							invoke: () => ({
								image: new Uint8Array(image),
								presentation: capture.request,
								locale: this.options.localization().locale,
								bundles: this.options.localization().bundles
							})
						},
						{
							channel: SCREENSHOT_READY_CHANNEL,
							validate: noArguments,
							invoke: () => {
								ready();
							}
						},
						{
							channel: SCREENSHOT_COMPLETE_CHANNEL,
							validate: validateScreenshotCompletion,
							invoke: (value) => this.complete(capture, view, value as ScreenshotCompletion)
						}
					]
				)
			);
			const closed = (): void => {
				if (!capture.closing && this.capture === capture) this.finish();
			};
			view.on('closed', closed);
			view.webContents.on('render-process-gone', closed);
			resources.add(
				toDisposable(() => {
					ready();
					if (!view.isDestroyed()) {
						view.off('closed', closed);
						view.destroy();
					}
				})
			);
			loaded.push(
				(async () => {
					const timeout = setTimeout(() => {
						if (this.capture === capture && capture.generation === generation)
							this.finish(undefined, new Error('ScreenshotOverlayUnavailable'));
					}, 15_000);
					resources.add(toDisposable(() => clearTimeout(timeout)));
					if (this.options.entry.useDevelopmentUrl) await view.loadURL(this.options.entry.url);
					else await view.loadFile(this.options.entry.file);
					await rendered;
					clearTimeout(timeout);
				})()
			);
		}
		await Promise.all(loaded);
		if (this.capture !== capture || capture.generation !== generation) return;
		for (const view of capture.views) if (!view.isDestroyed()) view.showInactive();
		const index = Math.max(
			0,
			frames.findIndex((frame) => frame.displayId === preferred)
		);
		capture.views[index]?.focus();
	}

	private getPermission(): ScreenshotPermission {
		return {
			status: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
			canOpenSystemSettings: process.platform === 'darwin',
			applicationPath:
				process.platform === 'darwin' ? dirname(dirname(dirname(app.getPath('exe')))) : app.getPath('exe')
		};
	}

	private async openPermissionSettings(): Promise<void> {
		await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
	}

	private needsScreenPermission(includeUndetermined = false): boolean {
		if (process.platform !== 'darwin') return false;
		const status = systemPreferences.getMediaAccessStatus('screen');
		return status === 'denied' || status === 'restricted' || (includeUndetermined && status === 'not-determined');
	}

	private async showPermissionGuide(capture: Capture): Promise<void> {
		if (this.capture !== capture || this.owner.isDestroyed()) return;
		// TCC identifies the running bundle, which is Electron.app for an unpackaged development launch.
		const bundlePath = this.getPermission().applicationPath;
		const bundleName = basename(bundlePath);
		const messages = this.options.localization().bundles.ash;
		const controller = new AbortController();
		const lifetime = capture.lifetime.add(toDisposable(() => controller.abort()));
		try {
			const result = await dialog.showMessageBox(this.owner, {
				type: 'info',
				message:
					messages?.['screenshot.permission.title'] ??
					localize2('screenshot.permission.title', 'Allow screen capture').original,
				detail:
					formatNlsMessage(
						messages?.['screenshot.permission.detail'] ??
						localize2(
							'screenshot.permission.detail',
							'To capture your screen, enable {0} in System Settings → Privacy & Security → Screen & System Audio Recording. If it is missing, click + and select the application shown below.\n\nCurrent application: {1}\n\nAfter granting access, quit and reopen the application if macOS asks, then try Screenshot again.'
						).original,
						{ '0': bundleName, '1': bundlePath }
					) +
					(app.isPackaged
						? ''
						: '\n\n' +
						formatNlsMessage(
							messages?.['screenshot.permission.development'] ??
							localize2(
								'screenshot.permission.development',
								'This development instance runs as {0}. Grant access to this application; a packaged Ash.app has its own permission.'
							).original,
							{ '0': bundleName }
						)),
				buttons: [
					messages?.['screenshot.permission.openSettings'] ??
					localize2('screenshot.permission.openSettings', 'Open System Settings').original,
					messages?.['screenshot.permission.showApplication'] ??
					localize2('screenshot.permission.showApplication', 'Show Application in Finder').original,
					messages?.['screenshot.permission.cancel'] ??
					localize2('screenshot.permission.cancel', 'Cancel').original
				],
				defaultId: 0,
				cancelId: 2,
				signal: controller.signal
			});
			if (this.capture !== capture || this.owner.isDestroyed()) return;
			this.finish();
			if (result.response === 0) await this.openPermissionSettings();
			else if (result.response === 1) shell.showItemInFolder(bundlePath);
		} finally {
			capture.lifetime.delete(lifetime);
			lifetime.dispose();
		}
	}

	private async complete(
		capture: Capture,
		sender: BrowserWindow,
		completion: ScreenshotCompletion
	): Promise<boolean> {
		if (this.capture !== capture || capture.closing || capture.completing) return false;
		if (completion.kind === 'cancel') {
			this.finish();
			return true;
		}
		if (completion.kind === 'retake') {
			// Reply before destroying the requesting renderer. The capture promise stays with the original draft.
			setImmediate(() => {
				if (this.capture !== capture) return;
				capture.closing = true;
				capture.windows.dispose();
				capture.windows = new DisposableStore();
				capture.views.length = 0;
				capture.closing = false;
				void this.open(capture).catch((error) => {
					if (this.capture === capture) this.finish(undefined, error);
				});
			});
			return true;
		}
		capture.completing = true;
		try {
			if (completion.kind === 'copy') {
				await clipboard.write([
					new ClipboardItem({
						'image/png': new Blob([new Uint8Array(completion.image)], { type: 'image/png' })
					})
				]);
			} else if (completion.kind === 'save') {
				for (const view of capture.views) if (!view.isDestroyed()) view.hide();
				const messages = this.options.localization().bundles.ash;
				const destination = await dialog.showSaveDialog(this.owner, {
					title: messages?.['screenshot.saveTitle'] ?? 'Save screenshot',
					defaultPath: 'Screenshot.png',
					filters: [{ name: 'PNG', extensions: ['png'] }]
				});
				if (this.capture !== capture) return true;
				if (destination.canceled || !destination.filePath) {
					for (const view of capture.views) if (!view.isDestroyed()) view.showInactive();
					if (!sender.isDestroyed()) sender.focus();
					return false;
				}
				await writeFile(destination.filePath, completion.image);
			}
			if (this.capture === capture) this.finish(completion.kind === 'attach' ? completion.image : undefined);
			return true;
		} catch (error) {
			if (this.capture === capture) {
				for (const view of capture.views) if (!view.isDestroyed()) view.showInactive();
				if (!sender.isDestroyed()) sender.focus();
			}
			throw error;
		} finally {
			capture.completing = false;
		}
	}

	private finish(image?: Uint8Array, error?: unknown): void {
		const capture = this.capture;
		if (!capture) return;
		this.capture = undefined;
		if (activeCapture === this) activeCapture = undefined;
		capture.closing = true;
		capture.windows.dispose();
		capture.lifetime.dispose();
		if (!this.owner.isDestroyed() && !this.isDisposed) this.owner.focus();
		if (error) capture.reject(error);
		else capture.resolve(image);
	}
}

function noArguments(value: unknown): void {
	if (value !== undefined) throw new TypeError('Unexpected screenshot arguments');
}
