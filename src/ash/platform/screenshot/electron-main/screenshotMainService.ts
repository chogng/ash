import { randomUUID } from 'node:crypto';
import { localize2 } from '../../../nls.js';
import { SCREEN_CAPTURE_PERMISSION_REQUIRED } from '../../native/common/native.js';
import { getDesktopScreenshots } from '../../native/electron-main/nativeHostMainService.js';
import {
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
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import {
	normalizeEntryUrl,
	type TrustedIpcRouter
} from '../../ipc/electron-main/trustedIpcRouter.js';
import {
	SCREENSHOT_COMPLETE_CHANNEL,
	SCREENSHOT_INITIALIZE_CHANNEL,
	SCREENSHOT_READY_CHANNEL,
	validateScreenshotCompletion,
	type ScreenshotCompletion,
	type ScreenshotWindowRequest
} from '../common/screenshot.js';

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
	readonly request: ScreenshotWindowRequest;
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

/** Owns OS screen acquisition, isolated native presentation and explicit image output. */
export class ScreenshotMainService extends Disposable {
	private capture: Capture | undefined;

	constructor(
		private readonly owner: BrowserWindow,
		private readonly options: ScreenshotWindowOptions
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
			})
		);
	}

	show(request: ScreenshotWindowRequest): Promise<Uint8Array | undefined> {
		return this.start(request);
	}

	public async pin(image: Uint8Array, input: ScreenshotWindowRequest['input']): Promise<void> {
		if (this.isDisposed || this.owner.isDestroyed()) { return; }
		await openPinnedImage(image, this.owner, input, this.options, () => !this.isDisposed && !this.owner.isDestroyed());
	}

	cancel(id: string): void {
		if (this.capture?.request.id === id) this.finish();
	}

	captureDesktop(colorScheme: string, accessibilityHints: boolean): Promise<Uint8Array | undefined> {
		return this.start({ id: randomUUID(), input: { defaultAction: 'copy', colorScheme, accessibilityHints } });
	}

	private start(request: ScreenshotWindowRequest): Promise<Uint8Array | undefined> {
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
			throw new Error(SCREEN_CAPTURE_PERMISSION_REQUIRED);
		}
		// Permission setup belongs to the requesting Workbench entry, before acquisition starts.
		const frames = await getDesktopScreenshots().catch(async (error) => {
			if (this.needsScreenPermission()) {
				throw new Error(SCREEN_CAPTURE_PERMISSION_REQUIRED);
			}
			throw error;
		});
		if (!frames || this.capture !== capture || capture.generation !== generation || this.owner.isDestroyed())
			return;
		if (this.needsScreenPermission()) {
			throw new Error(SCREEN_CAPTURE_PERMISSION_REQUIRED);
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
								kind: 'capture',
								input: capture.request.input,
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
							this.finish(undefined, new Error('ScreenshotWindowUnavailable'));
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

	private needsScreenPermission(): boolean {
		return process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted';
	}

	private async complete(
		capture: Capture,
		sender: BrowserWindow,
		completion: ScreenshotCompletion
	): Promise<boolean> {
		if (this.capture !== capture || capture.closing || capture.completing) return false;
		if (completion.kind === 'error') { this.finish(undefined, new Error(completion.message)); return true; }
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
				void this.open(capture).catch((error) => {
					if (this.capture === capture) this.finish(undefined, error);
				});
			});
			return true;
		}
		capture.completing = true;
		try {
			if (completion.kind === 'pin') {
				await openPinnedImage(completion.image, sender, capture.request.input, this.options, () => this.capture === capture && !capture.closing);
			} else if (completion.kind === 'copy') {
				await clipboard.write([
					new ClipboardItem({
						'image/png': new Blob([new Uint8Array(completion.image)], { type: 'image/png' })
					})
				]);
			} else if (completion.kind === 'save') {
				for (const view of capture.views) if (!view.isDestroyed()) view.hide();
				const messages = this.options.localization().bundles.ash;
				const destination = await dialog.showSaveDialog(this.owner, {
					title: messages?.['imageEditor.saveTitle'] ?? localize2('imageEditor.saveTitle', 'Save image').original,
					defaultPath: 'Image.png',
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
		if (capture.request.input.defaultAction !== 'copy' && !this.owner.isDestroyed() && !this.isDisposed) this.owner.focus();
		if (error) capture.reject(error);
		else capture.resolve(image);
	}
}

function noArguments(value: unknown): void {
	if (value !== undefined) throw new TypeError('Unexpected image view arguments');
}

/** After readiness, only the detached window owns these resources, never the capture or its owner. */
async function openPinnedImage(
	image: Uint8Array,
	source: BrowserWindow,
	input: ScreenshotWindowRequest['input'],
	options: ScreenshotWindowOptions,
	isCurrent: () => boolean
): Promise<void> {
	const header = new DataView(image.buffer, image.byteOffset, image.byteLength);
	const size = { width: header.getUint32(16), height: header.getUint32(20) };
	const area = screen.getDisplayMatching(source.getBounds()).workArea;
	const scale = Math.min(1, (area.width - 40) / size.width, (area.height - 120) / size.height);
	const view = new BrowserWindow({
		width: Math.max(320, Math.round(size.width * scale)),
		height: Math.max(200, Math.round(size.height * scale) + 80),
		minWidth: 320,
		minHeight: 200,
		show: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		fullscreenable: false,
		webPreferences: {
			...options.webPreferences,
			partition: 'ash-screenshot',
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true
		}
	});
	const resources = new DisposableStore();
	const contents = view.webContents;
	let ready!: () => void;
	let fail!: (error: Error) => void;
	const rendered = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
	// Setup can fail before navigation starts; cleanup must still settle readiness.
	void rendered.catch(() => { });
	let busy = false;
	view.setAlwaysOnTop(true, 'floating');
	if (process.platform === 'darwin') {
		view.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}
	view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	const preventNavigation = (event: Electron.Event): void => event.preventDefault();
	view.webContents.on('will-navigate', preventNavigation);
	const close = (): void => {
		fail(new Error('Pinned image window closed'));
		resources.dispose();
	};
	view.on('closed', close);
	view.webContents.on('render-process-gone', close);
	resources.add(toDisposable(() => {
		fail(new Error('ScreenshotWindowUnavailable'));
		view.off('closed', close);
		if (!contents.isDestroyed()) {
			contents.off('render-process-gone', close);
			contents.off('will-navigate', preventNavigation);
		}
		if (!view.isDestroyed()) {
			view.destroy();
		}
	}));
	try {
		resources.add(options.router.register({
			webContents: view.webContents,
			allowedEntryUrls: new Set([normalizeEntryUrl(options.entry.url)])
		}, [
			{
				channel: SCREENSHOT_INITIALIZE_CHANNEL,
				validate: noArguments,
				invoke: () => ({
					image: new Uint8Array(image),
					kind: 'pinned',
					input,
					locale: options.localization().locale,
					bundles: options.localization().bundles
				})
			},
			{ channel: SCREENSHOT_READY_CHANNEL, validate: noArguments, invoke: ready },
			{
				channel: SCREENSHOT_COMPLETE_CHANNEL,
				validate: validateScreenshotCompletion,
				invoke: async (value) => {
					const result = value as ScreenshotCompletion;
					if (busy || view.isDestroyed()) { return false; }
					if (result.kind === 'cancel' || result.kind === 'error') {
						setImmediate(() => resources.dispose());
						return true;
					}
					// Copy/save always use the owned pixels; the renderer cannot replace a pinned image.
					if (result.kind !== 'copy' && result.kind !== 'save') { return false; }
					busy = true;
					try {
						if (result.kind === 'copy') {
							await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image)], { type: 'image/png' }) })]);
						} else {
							const destination = await dialog.showSaveDialog(view, {
								title: options.localization().bundles.ash?.['imageEditor.saveTitle'] ?? localize2('imageEditor.saveTitle', 'Save image').original,
								defaultPath: 'Image.png', filters: [{ name: 'PNG', extensions: ['png'] }]
							});
							if (!view.isDestroyed() && !destination.canceled && destination.filePath) {
								await writeFile(destination.filePath, image);
							}
						}
						return false;
					} finally { busy = false; }
				}
			}
		]));
		const timeout = setTimeout(() => fail(new Error('ScreenshotWindowUnavailable')), 15_000);
		resources.add(toDisposable(() => clearTimeout(timeout)));
		// Observe readiness rejection immediately, including failures during navigation.
		await Promise.all([
			options.entry.useDevelopmentUrl ? view.loadURL(options.entry.url) : view.loadFile(options.entry.file),
			rendered
		]);
		clearTimeout(timeout);
		if (!isCurrent()) {
			resources.dispose();
			return;
		}
		view.show();
	} catch (error) {
		resources.dispose();
		throw error;
	}
}
