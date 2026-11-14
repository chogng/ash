import { AuxiliaryWindow, BrowserAuxiliaryWindowService, type AuxiliaryWindowState, type IAuxiliaryWindow } from '../browser/auxiliaryWindowService.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IAuxiliaryWindowState } from '../../../../platform/window/common/window.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { NativeWindowClientArea } from '../../../../platform/window/electron-browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { CONFIRM_BEFORE_CLOSE_SETTING } from '../../../../platform/window/common/window.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ModifierKeyEmitter } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IHostService } from '../../host/browser/host.js';

/** Uses host state for editor-window restoration while the shared browser service owns its document. */
export class ElectronAuxiliaryWindowService extends BrowserAuxiliaryWindowService {
	constructor(
		opener: Window,
		root: HTMLElement,
		@IStorageService storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(opener, root, storage, instantiationService);
	}

	protected override createAuxiliaryWindow(target: Window, title: string): AuxiliaryWindow {
		return this.instantiationService.createInstance(ElectronAuxiliaryWindow, this.opener, target, this.workbenchRoot, title);
	}
}

class ElectronAuxiliaryWindow extends AuxiliaryWindow {
	private state: IAuxiliaryWindowState | undefined;
	private readonly pinChanged = this._register(new Emitter<boolean>());
	override readonly alwaysOnTop: NonNullable<IAuxiliaryWindow['alwaysOnTop']>;

	constructor(
		source: Window,
		target: Window,
		root: HTMLElement,
		title: string,
		@IThemeService themes: IThemeService,
		@IHostService hostService: IHostService,
		@INativeHostService private readonly host: INativeHostApi,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super(source, target, root, title, themes, hostService);
		const owner = this;
		this.alwaysOnTop = {
			get value() { return owner.state?.alwaysOnTop ?? false; },
			onDidChange: this.pinChanged.event,
			set: value => host.setAlwaysOnTop(value, target.name),
		};
		this.modifiers = ModifierKeyEmitter.getInstance(target);
		this._register(toDisposable(() => ModifierKeyEmitter.disposeInstance(target)));
	}

	private readonly modifiers: ModifierKeyEmitter;

	protected override shouldConfirmClose(): boolean {
		const setting = this.configuration.getValue<string>(CONFIRM_BEFORE_CLOSE_SETTING);
		const { altKey, ctrlKey, metaKey, shiftKey } = this.modifiers.keyStatus;
		return setting === 'always' || (setting === 'keyboardOnly' && (altKey || ctrlKey || metaKey || shiftKey));
	}

	protected override async confirmClose(): Promise<boolean> {
		const result = await this.dialogs.confirm({
			message: localize('auxiliaryWindow.confirmClose', 'Close this window?'),
			primaryButton: localize('auxiliaryWindow.close', 'Close Window'),
		});
		return result.confirmed;
	}

	protected override showCloseVeto(reason: string): Promise<void> {
		return this.dialogs.error(reason);
	}

	protected override closeWindow(): Promise<void> {
		return this.host.closeWindow(this.window.name);
	}

	override focus(): Promise<void> {
		// Chromium's Window.focus() does not activate the existing native popup.
		return this.host.focusWindow(this.window.name);
	}

	override async initialize(): Promise<number> {
		const name = this.window.name;
		const changed = this.host.onDidChangeAuxiliaryWindowState(event => {
			if (event.windowName !== name) return;
			const previous = this.state?.alwaysOnTop;
			this.state = event.state;
			if (previous !== this.state.alwaysOnTop) this.pinChanged.fire(this.state.alwaysOnTop);
		});
		this._register(toDisposable(() => changed.dispose()));

		// Subscribe to both streams before asking Main for its registered window snapshot.
		const snapshot = Promise.resolve().then(() => this.host.getAuxiliaryWindowInitialization(name));
		const clientArea = this._register(new NativeWindowClientArea(
			this.container, this.host, name, () => this.layout(),
			async () => (await snapshot).clientSize,
		));
		const [initial] = await Promise.all([snapshot, clientArea.ready, this.whenStylesHaveLoaded]);
		this.state ??= initial.state;
		return initial.id;
	}

	override createState(): AuxiliaryWindowState {
		// The host is authoritative; this event-fed snapshot keeps synchronous layout persistence possible.
		return { ...super.createState(), ...this.state };
	}
}
