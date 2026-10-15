import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { isMacintosh } from "../../../../base/common/platform.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import type {
	INativeMenubarApi,
} from "../../../../platform/menubar/common/nativeMenubar.js";
import {
	BrowserMenubarControl,
	type IMenubarControl,
} from "../../../browser/parts/titlebar/menubarControl.js";
import {
	BrowserTitlebarPart,
	BrowserTitleService,
	AuxiliaryBrowserTitlebarPart,
	type ITitlebarPartFactoryOptions,
} from "../../../browser/parts/titlebar/titlebarPart.js";
import { NativeMenubarControl } from "./menubarControl.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { titleBarActionForeground, titleBarBackground } from "../../../common/theme.js";
import { dialogBackdropBackground } from '../../../../platform/theme/common/colors/componentColors.js';
import { INativeHostService } from "../../../common/services.js";
import type { INativeHostApi } from "../../../../platform/native/common/nativeHost.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IEditorGroupsContainer } from '../../../services/editor/common/editorGroupsService.js';
import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IsWindowAlwaysOnTopContext } from '../../../common/contextkeys.js';
import "./titlebarpart.css";

/**
 * Desktop titlebar integration for Electron's native window controls overlay.
 *
 * Owns the draggable region, host control space, and window control colors.
 */
export class NativeTitlebarPart extends BrowserTitlebarPart {
	constructor(
		container: HTMLElement,
		options: ITitlebarPartFactoryOptions,
		nativeMenubar: INativeMenubarApi,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IThemeService themeService: IThemeService,
		@INativeHostService hostService: INativeHostApi,
		@IStorageService storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(
			container,
			options,
			(menus, contextMenus, localization) => new ElectronMenubarControl(container, nativeMenubar, menus, contextMenus, localization),
			instantiationService,
			menuService,
			contextMenuService,
			localizationService, themeService, storageService, contextKeyService
		);
		this.domNode.classList.add("ash-electron-titlebar");
		this._register(bindWindowControlTheme(themeService, hostService));
	}
}

/** Selects desktop chrome for auxiliary editor windows as well as the main window. */
export class ElectronTitleService extends BrowserTitleService {
	protected override doCreateAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService, onDispose: () => void): AuxiliaryBrowserTitlebarPart {
		return instantiationService.createInstance(AuxiliaryElectronTitlebarPart, container, this.productName, editorGroupsContainer, onDispose);
	}
}

/** Retains each editor window's title model while integrating Electron's drag and controls regions. */
class AuxiliaryElectronTitlebarPart extends AuxiliaryBrowserTitlebarPart {

	constructor(
		container: HTMLElement,
		productName: string,
		editorGroupsContainer: IEditorGroupsContainer,
		onDispose: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ILocalizationService localizationService: ILocalizationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INativeHostService hostService: INativeHostApi,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(container, productName, editorGroupsContainer, onDispose, isMacintosh ? 'actions-only' : 'application-menu',
			instantiationService, menuService, contextMenuService, localizationService, themeService, storageService, contextKeyService);
		const targetWindow = getWindow(container);
		const alwaysOnTop = IsWindowAlwaysOnTopContext.bindTo(this.contextKeyService);
		let revision = 0;
		const refresh = async (): Promise<void> => {
			const pendingRevision = ++revision;
			const pinned = await hostService.isAlwaysOnTop(targetWindow.name);
			if (!this.isDisposed && pendingRevision === revision) alwaysOnTop.set(pinned);
		};
		this._register(addDisposableListener(targetWindow, 'focus', () => { void refresh().catch(onUnexpectedError); }));
		const stateListener = hostService.onDidChangeWindowAlwaysOnTop(event => {
			if (event.windowName !== targetWindow.name) return;
			// An event supersedes any in-flight initial or focus read.
			revision++;
			alwaysOnTop.set(event.alwaysOnTop);
		});
		this._register(toDisposable(() => stateListener.dispose()));
		void refresh().catch(onUnexpectedError);
		void hostService.getTitleBarStyle().then(style => {
			if (!this.isDisposed) this.domNode.classList.toggle('ash-electron-titlebar', style === 'custom');
		}).catch(error => console.error('Failed to read auxiliary window titlebar style', error));
		// The opener's appearance host also updates its registered auxiliary window controls.
		this._register(bindWindowControlTheme(themeService, hostService));
	}

}

/** Applies titlebar colors to the operating-system window controls for one renderer. */
export function bindWindowControlTheme(themeService: IThemeService, hostService: INativeHostApi): IDisposable {
	const update = (): void => {
		const theme = themeService.getColorTheme();
		const backgroundColor = theme.getColorCss(titleBarBackground);
		const symbolColor = theme.getColorCss(titleBarActionForeground);
		const backdropColor = theme.getColorCss(dialogBackdropBackground);
		if (!backgroundColor || !symbolColor || !backdropColor) {
			throw new Error(`Theme '${theme.id}' does not define window control colors`);
		}
		void hostService.setWindowTheme({ backgroundColor, symbolColor, backdropColor }).catch((error: unknown) => {
			console.error('Failed to apply window control colors', error);
		});
	};
	const subscription = themeService.onDidColorThemeChange(update);
	update();
	return toDisposable(() => subscription.dispose());
}

/**
 * Windows and Linux show the shared menu tree through the compact titlebar button.
 * macOS presents the tree in the system menu bar and keeps the other left actions.
 */
class ElectronMenubarControl extends Disposable
	implements IMenubarControl {
	readonly domNode: HTMLElement;

	constructor(
		container: HTMLElement,
		nativeMenubar: INativeMenubarApi,
		menuService: IMenuService,
		contextMenuService: IContextMenuService,
		localizationService: ILocalizationService,
	) {
		super();
		const browserMenubar = this._register(new BrowserMenubarControl(
			container,
			menuService,
			contextMenuService,
			localizationService,
			{ presentation: isMacintosh ? 'actions-only' : 'application-menu' },
		));
		this.domNode = browserMenubar.domNode;
		if (isMacintosh) {
			this._register(new NativeMenubarControl(
				menuService,
				nativeMenubar,
			));
		}
	}
}
