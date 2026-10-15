import { AuxiliaryWindow, BrowserAuxiliaryWindowService, type AuxiliaryWindowOpenOptions, type AuxiliaryWindowState, type IAuxiliaryWindow } from '../browser/auxiliaryWindowService.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IAuxiliaryWindowState } from '../../../../platform/window/common/window.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';

/** Uses host state for editor-window restoration while the shared browser service owns its document. */
export class ElectronAuxiliaryWindowService extends BrowserAuxiliaryWindowService {
	constructor(
		opener: Window,
		root: HTMLElement,
		@IThemeService themes: IThemeService,
		@IStorageService storage: IStorageService,
		@INativeHostService private readonly host: INativeHostApi,
	) {
		super(opener, root, themes, storage);
	}

	protected override createAuxiliaryWindow(target: Window, title: string): AuxiliaryWindow {
		return new ElectronAuxiliaryWindow(this.opener, target, this.workbenchRoot, this.themeService, title, this.host);
	}

	override async open(options?: AuxiliaryWindowOpenOptions): Promise<IAuxiliaryWindow> {
		const window = await super.open(options) as ElectronAuxiliaryWindow;
		try {
			await window.initializeHostState();
			return window;
		} catch (error) {
			window.dispose();
			throw error;
		}
	}
}

class ElectronAuxiliaryWindow extends AuxiliaryWindow {
	private state: IAuxiliaryWindowState | undefined;
	private revision = 0;

	constructor(source: Window, target: Window, root: HTMLElement, themes: IThemeService, title: string, private readonly host: INativeHostApi) {
		super(source, target, root, themes, title);
		const changed = host.onDidChangeAuxiliaryWindowState(event => {
			if (event.windowName !== target.name) {
				return;
			}
			this.revision++;
			this.state = event.state;
		});
		this._register(toDisposable(() => changed.dispose()));
	}

	async initializeHostState(): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Auxiliary window closed before initialization');
		}
		const revision = this.revision;
		const state = await this.host.getAuxiliaryWindowState(this.window.name);
		if (this.isDisposed) {
			throw new Error('Auxiliary window closed during initialization');
		}
		if (this.revision === revision) {
			this.state = state;
		}
	}

	override createState(): AuxiliaryWindowState {
		// The host is authoritative; this event-fed snapshot keeps synchronous layout persistence possible.
		return { ...super.createState(), ...this.state };
	}
}
