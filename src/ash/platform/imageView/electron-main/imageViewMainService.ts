import { nativeImage, shell } from 'electron';
import { basename, dirname, join } from 'node:path';
import { localize2 } from '../../../nls.js';
import { getDesktopScreenshots } from '../../native/electron-main/nativeHostMainService.js';
import {
	app,
	BrowserWindow,
	clipboard,
	ClipboardItem,
	dialog,
	screen,
	systemPreferences,
	type WebPreferences,
	type Display,
} from 'electron/main';
import { writeFile } from 'node:fs/promises';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { normalizeEntryUrl, type IpcRoute, type TrustedIpcRouter } from '../../ipc/electron-main/trustedIpcRouter.js';
import {
	IMAGE_VIEW_OPEN_CHANNEL,
	IMAGE_VIEW_CANCEL_CHANNEL,
	IMAGE_VIEW_COMPLETE_CHANNEL,
	IMAGE_VIEW_INITIALIZE_CHANNEL,
	IMAGE_VIEW_READY_CHANNEL,
	IMAGE_VIEW_PERMISSION_CHANNEL,
	validateImageViewPermissionAction,
	validateImageViewCompletion,
	validateImageViewId,
	validateImageViewRequest,
	type ImageViewCompletion,
	type ImageViewRequest,
} from '../common/imageView.js';

interface ImageViewWindowOptions {
	readonly entry: { readonly file: string; readonly url: string; readonly useDevelopmentUrl: boolean };
	readonly webPreferences: WebPreferences;
	readonly router: TrustedIpcRouter;
	readonly localization: () => {
		readonly locale: string;
		readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
	};
}

interface Capture {
	readonly request: ImageViewRequest;
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
let activeCapture: ImageViewMainService | undefined;

/** Owns OS screen acquisition, isolated native presentation and explicit image output. */
export class ImageViewMainService extends Disposable {
	private capture: Capture | undefined;

	constructor(
		private readonly owner: BrowserWindow,
		private readonly options: ImageViewWindowOptions,
	) {
		super();
		const webContents = owner.webContents;
		const cancel = (): void => {
			this.finish();
		};
		const navigating = (_event: unknown, _url: unknown, inPlace: boolean, mainFrame: boolean): void => {
			if (mainFrame && !inPlace) {
				this.finish();
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
			}),
		);
	}

	routes(): readonly IpcRoute<unknown, unknown>[] {
		return [
			{
				channel: IMAGE_VIEW_OPEN_CHANNEL,
				validate: validateImageViewRequest,
				invoke: value => this.start(value as ImageViewRequest),
			},
			{
				channel: IMAGE_VIEW_CANCEL_CHANNEL,
				validate: validateImageViewId,
				invoke: value => {
					if (this.capture?.request.id === value) this.finish();
				},
			},
		];
	}

	private start(request: ImageViewRequest): Promise<Uint8Array | undefined> {
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
				completing: false,
			};
			this.capture = capture;
			const displaysChanged = (): void => {
				if (this.capture === capture) this.finish();
			};
			const displayMetricsChanged = (_event: unknown, _display: Display, metrics: string[]): void => {
				// Dock/menu visibility changes only workArea; frozen desktop coordinates remain valid.
				if (metrics.some(metric => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation'))
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
				}),
			);
			void this.open(capture).catch(error => {
				if (this.capture === capture) this.finish(undefined, error);
			});
		});
	}

	private async open(capture: Capture): Promise<void> {
		const generation = ++capture.generation;
		if (capture.request.source === 'screen' && this.needsScreenPermission()) {
			await this.showPermissionGuide(capture);
			return;
		}
		// An undetermined permission must reach the OS capture request once so macOS can ask for consent.
		const frames =
			capture.request.source === 'content'
				? [
						{
							displayId: screen.getDisplayMatching(this.owner.getBounds()).id,
							bounds: screen.getDisplayMatching(this.owner.getBounds()).bounds,
							image: { buffer: new Uint8Array() },
						},
					]
				: await getDesktopScreenshots().catch(async error => {
						if (this.needsScreenPermission(true)) {
							await this.showPermissionGuide(capture);
							return undefined;
						}
						throw error;
					});
		if (!frames || this.capture !== capture || capture.generation !== generation || this.owner.isDestroyed())
			return;
		if (capture.request.source === 'screen' && this.needsScreenPermission(true)) {
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
					partition: 'ash-image-view',
					backgroundThrottling: false,
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true,
				},
			});
			capture.views.push(view);
			view.setAlwaysOnTop(true, 'screen-saver');
			if (process.platform === 'darwin') view.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
			view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
			view.webContents.session.setPermissionCheckHandler(() => false);
			view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			view.webContents.on('will-navigate', event => event.preventDefault());
			const resources = capture.windows.add(new DisposableStore());
			let ready!: () => void;
			const rendered = new Promise<void>(resolve => {
				ready = resolve;
			});
			resources.add(
				this.options.router.register(
					{
						webContents: view.webContents,
						allowedEntryUrls: new Set([normalizeEntryUrl(this.options.entry.url)]),
					},
					[
						{
							channel: IMAGE_VIEW_INITIALIZE_CHANNEL,
							validate: noArguments,
							invoke: () => ({
								image: new Uint8Array(image),
								presentation: capture.request,
								locale: this.options.localization().locale,
								bundles: this.options.localization().bundles,
							}),
						},
						{
							channel: IMAGE_VIEW_READY_CHANNEL,
							validate: noArguments,
							invoke: () => {
								ready();
							},
						},
						{
							channel: IMAGE_VIEW_COMPLETE_CHANNEL,
							validate: validateImageViewCompletion,
							invoke: value => this.complete(capture, view, value as ImageViewCompletion),
						},
					],
				),
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
				}),
			);
			loaded.push(
				(async () => {
					const timeout = setTimeout(() => {
						if (this.capture === capture && capture.generation === generation)
							this.finish(undefined, new Error('ImageViewUnavailable'));
					}, 15_000);
					resources.add(toDisposable(() => clearTimeout(timeout)));
					if (this.options.entry.useDevelopmentUrl) await view.loadURL(this.options.entry.url);
					else await view.loadFile(this.options.entry.file);
					await rendered;
					clearTimeout(timeout);
				})(),
			);
		}
		await Promise.all(loaded);
		if (this.capture !== capture || capture.generation !== generation) return;
		for (const view of capture.views) if (!view.isDestroyed()) view.showInactive();
		const index = Math.max(
			0,
			frames.findIndex(frame => frame.displayId === preferred),
		);
		capture.views[index]?.focus();
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
		// TCC grants access to the running bundle, which can differ from the installed release.
		const bundlePath = dirname(dirname(dirname(app.getPath('exe'))));
		// The shipped application artwork avoids an OS file-icon lookup for our own bundle.
		const icon = nativeImage
			.createFromPath(join(app.getAppPath(), 'resources', 'darwin', 'ash.png'))
			.resize({ width: 64, height: 64 });
		if (icon.isEmpty()) throw new Error('ImageViewUnavailable');
		if (this.capture !== capture || this.owner.isDestroyed()) return;
		const area = screen.getDisplayMatching(this.owner.getBounds()).workArea;
		const width = Math.min(360, area.width);
		const height = Math.min(168, area.height);
		const guide = new BrowserWindow({
			x: area.x + Math.min(24, area.width - width),
			y: area.y + Math.max(0, area.height - height - 24),
			width,
			height,
			minWidth: width,
			minHeight: height,
			show: false,
			opacity: 0,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			webPreferences: {
				...this.options.webPreferences,
				partition: 'ash-image-view',
				backgroundThrottling: false,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
			},
		});
		// A modeless companion stays visible beside System Settings without owning its window or focus.
		guide.setAlwaysOnTop(true, 'floating');
		guide.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		guide.webContents.session.setPermissionCheckHandler(() => false);
		guide.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		const navigating = (event: Electron.Event): void => event.preventDefault();
		guide.webContents.on('will-navigate', navigating);
		const resources = capture.windows.add(new DisposableStore());
		let ready!: () => void;
		const rendered = new Promise<void>(resolve => {
			ready = resolve;
		});
		let complete!: (retry: boolean) => void;
		const completed = new Promise<boolean>(resolve => {
			complete = resolve;
		});
		const closed = (): void => {
			ready();
			complete(false);
		};
		const resumeIfGranted = (): void => {
			// Returning from Settings replaces a separate Continue action. A drop alone never grants access.
			if (
				this.capture === capture &&
				!guide.isDestroyed() &&
				systemPreferences.getMediaAccessStatus('screen') === 'granted'
			) {
				complete(true);
			} else if (
				this.capture === capture &&
				!guide.isDestroyed() &&
				guide.isVisible() &&
				this.owner.isFocused()
			) {
				guide.focus();
			}
		};
		guide.on('closed', closed);
		guide.on('focus', resumeIfGranted);
		this.owner.on('focus', resumeIfGranted);
		guide.webContents.on('render-process-gone', closed);
		resources.add(
			toDisposable(() => {
				ready();
				complete(false);
				guide.off('closed', closed);
				guide.off('focus', resumeIfGranted);
				this.owner.off('focus', resumeIfGranted);
				if (!guide.isDestroyed()) {
					guide.webContents.off('will-navigate', navigating);
					guide.webContents.off('render-process-gone', closed);
					guide.destroy();
				}
			}),
		);
		resources.add(
			this.options.router.register(
				{
					webContents: guide.webContents,
					allowedEntryUrls: new Set([normalizeEntryUrl(this.options.entry.url)]),
				},
				[
					{
						channel: IMAGE_VIEW_INITIALIZE_CHANNEL,
						validate: noArguments,
						invoke: () => ({
							permission: { applicationName: basename(bundlePath), icon: new Uint8Array(icon.toPNG()) },
							image: new Uint8Array(),
							presentation: capture.request,
							locale: this.options.localization().locale,
							bundles: this.options.localization().bundles,
						}),
					},
					{ channel: IMAGE_VIEW_READY_CHANNEL, validate: noArguments, invoke: ready },
					{
						channel: IMAGE_VIEW_COMPLETE_CHANNEL,
						validate: validateImageViewCompletion,
						invoke: value => {
							const result = value as ImageViewCompletion;
							if (result.kind === 'cancel') setImmediate(() => complete(false));
							else if (result.kind === 'error')
								setImmediate(
									() => this.capture === capture && this.finish(undefined, new Error(result.message)),
								);
							else throw new TypeError('Screen permission guide cannot export images');
							return true;
						},
					},
					{
						channel: IMAGE_VIEW_PERMISSION_CHANNEL,
						validate: validateImageViewPermissionAction,
						invoke: async action => {
							if (this.capture !== capture || guide.isDestroyed()) return false;
							switch (action) {
								case 'settings':
									await this.openPermissionSettings();
									break;
								case 'drag':
									guide.webContents.startDrag({ file: bundlePath, icon });
									break;
								case 'copyPath':
									await clipboard.writeText(bundlePath);
									break;
								case 'cancel':
									setImmediate(() => complete(false));
									break;
								case 'retry':
									// A completed drag is not a permission grant. Only the OS may authorize capture.
									if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') return false;
									setImmediate(() => complete(true));
									break;
							}
							return true;
						},
					},
				],
			),
		);
		const timeout = setTimeout(() => {
			if (this.capture === capture) this.finish(undefined, new Error('ImageViewUnavailable'));
		}, 15_000);
		resources.add(toDisposable(() => clearTimeout(timeout)));
		let retry = false;
		try {
			if (this.options.entry.useDevelopmentUrl) await guide.loadURL(this.options.entry.url);
			else await guide.loadFile(this.options.entry.file);
			await rendered;
			// Order the companion first, then let the Settings launch activate its own application.
			guide.showInactive();
			await this.openPermissionSettings();
			clearTimeout(timeout);
			if (this.capture === capture && !guide.isDestroyed()) {
				const placement = await import('./screenPermissionGuideWindow.js').catch(() => undefined);
				if (this.capture !== capture || guide.isDestroyed()) {
					return;
				}
				let lastBounds = '';
				let recordingList: Electron.Rectangle | undefined;
				let lastLayout = '';
				let nextControlsRead = 0;
				const followSettings = (): void => {
					if (guide.isDestroyed()) {
						return;
					}
					const info = placement?.getSystemSettingsWindowInfo();
					if (!info) {
						return;
					}
					const settings = info.bounds;
					const layout = `${info.pid}:${settings.width}:${settings.height}`;
					if (layout !== lastLayout || Date.now() >= nextControlsRead) {
						const list = placement!.getScreenRecordingListBounds(info);
						recordingList = list ? { ...list, x: list.x - settings.x, y: list.y - settings.y } : undefined;
						lastLayout = layout;
						nextControlsRead = Date.now() + 1_000;
					}
					const list = recordingList
						? { ...recordingList, x: recordingList.x + settings.x, y: recordingList.y + settings.y }
						: undefined;
					const workArea = screen.getDisplayMatching(settings).workArea;
					const [guideWidth, guideHeight] = guide.getSize();
					const key = JSON.stringify([settings, workArea, guideWidth, guideHeight, list]);
					if (key === lastBounds) {
						return;
					}
					lastBounds = key;
					const position = placement!.getPermissionGuidePosition(
						settings,
						{ width: guideWidth, height: guideHeight },
						workArea,
						list,
					);
					guide.setPosition(position.x, position.y, false);
				};
				followSettings();
				const tracking = setInterval(followSettings, 250);
				resources.add(toDisposable(() => clearInterval(tracking)));
				// Settings keeps keyboard focus; the card remains ready for a cross-application drag.
				guide.setOpacity(1);
				retry = await completed;
			}
		} finally {
			capture.windows.delete(resources);
			resources.dispose();
		}
		if (this.capture !== capture) return;
		if (retry) await this.open(capture);
		else this.finish();
	}

	private async complete(capture: Capture, sender: BrowserWindow, completion: ImageViewCompletion): Promise<boolean> {
		if (this.capture !== capture || capture.closing || capture.completing) return false;
		if (completion.kind === 'error') {
			this.finish(undefined, new Error(completion.message));
			return true;
		}
		if (completion.kind === 'cancel') {
			this.finish();
			return true;
		}
		if (completion.kind === 'retake') {
			// Reply before destroying the requesting renderer; keep the original interaction pending across retakes.
			setImmediate(() => {
				if (this.capture !== capture) return;
				capture.closing = true;
				capture.windows.dispose();
				capture.windows = new DisposableStore();
				capture.views.length = 0;
				capture.closing = false;
				void this.open(capture).catch(error => {
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
						'image/png': new Blob([new Uint8Array(completion.image)], { type: 'image/png' }),
					}),
				]);
			} else if (completion.kind === 'save') {
				for (const view of capture.views) if (!view.isDestroyed()) view.hide();
				const messages = this.options.localization().bundles.ash;
				const destination = await dialog.showSaveDialog(this.owner, {
					title: messages?.['imageView.saveTitle'] ?? localize2('imageView.saveTitle', 'Save image').original,
					defaultPath: 'Image.png',
					filters: [{ name: 'PNG', extensions: ['png'] }],
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
	if (value !== undefined) throw new TypeError('Unexpected image view arguments');
}
