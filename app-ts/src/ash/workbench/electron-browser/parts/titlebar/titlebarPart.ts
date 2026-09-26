import { isMacintosh } from "../../../../base/common/platform.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type {
	INativeMenubarApi,
} from "../../../../platform/menubar/common/nativeMenubar.js";
import {
	BrowserMenubarControl,
	type IMenubarControl,
} from "../../../browser/parts/titlebar/menubarControl.js";
import {
	BrowserTitlebarPart,
	type ITitlebarPartFactoryOptions,
	type TitlebarPartFactory,
} from "../../../browser/parts/titlebar/titlebarPart.js";
import { NativeMenubarControl } from "./menubarControl.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { titleBarActionForeground, titleBarBackground } from "../../../common/theme.js";
import { dialogBackdropBackground } from '../../../../platform/theme/common/colors/componentColors.js';
import { INativeHostService } from "../../../common/services.js";
import type { INativeHostApi } from "../../../../platform/native/common/nativeHost.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
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
		@IThemeService private readonly themeService: IThemeService,
		@INativeHostService private readonly hostService: INativeHostApi,
	) {
		super(
			container,
			options,
			new ElectronMenubarControl(container, options, nativeMenubar),
			instantiationService,
		);
		this.domNode.classList.add("ash-electron-titlebar");
		this._register(this.themeService.onDidColorThemeChange(() => this.updateStyles()));
		this.updateStyles();
	}

	public updateStyles(): void {
		const theme = this.themeService.getColorTheme();
		const backgroundColor = theme.getColorCss(titleBarBackground);
		const symbolColor = theme.getColorCss(titleBarActionForeground);
		const backdropColor = theme.getColorCss(dialogBackdropBackground);
		if (!backgroundColor || !symbolColor || !backdropColor) {
			throw new Error(`Theme '${theme.id}' does not define window control colors`);
		}
		void this.hostService.setWindowTheme({ backgroundColor, symbolColor, backdropColor }).catch((error: unknown) => {
			console.error("Failed to apply window control colors", error);
		});
	}
}

/**
 * Windows and Linux show the shared menu tree through the compact titlebar button.
 * macOS keeps that button and also presents the same tree in the system menu bar.
 */
class ElectronMenubarControl extends Disposable
	implements IMenubarControl {
	readonly domNode: HTMLElement;

	constructor(
		container: HTMLElement,
		options: ITitlebarPartFactoryOptions,
		nativeMenubar: INativeMenubarApi,
	) {
		super();
		const browserMenubar = this._register(new BrowserMenubarControl(
			container,
			options.menuService,
			options.contextMenuService,
			options.localizationService,
		));
		this.domNode = browserMenubar.domNode;
		if (isMacintosh) {
			this._register(new NativeMenubarControl(
				options.menuService,
				nativeMenubar,
			));
		}
	}
}

/** Creates the titlebar used by the Electron workbench. */
export function createElectronTitlebarPartFactory(
	nativeMenubar: INativeMenubarApi,
): TitlebarPartFactory {
	return (container, options, instantiationService) => instantiationService.createInstance(NativeTitlebarPart, container, options, nativeMenubar);
}
