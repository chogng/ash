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
import { NativeMenubarControl } from "./nativeMenubarControl.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { titleBarActionForeground, titleBarBackground } from "../../../common/theme.js";
import { INativeHostService } from "../../../common/services.js";
import type { INativeHostApi } from "../../../../platform/native/common/nativeHost.js";
import "./titlebarpart.css";

/**
 * Desktop titlebar integration for Electron's native window controls overlay.
 *
 * Owns the draggable region, host control space, and window control colors.
 */
export class ElectronTitlebarPart extends BrowserTitlebarPart {
	constructor(
		container: HTMLElement,
		options: ITitlebarPartFactoryOptions,
		nativeMenubar: INativeMenubarApi,
		@IThemeService private readonly themeService: IThemeService,
		@INativeHostService private readonly hostService: INativeHostApi,
	) {
		super(
			container,
			options,
			new ElectronMenubarControl(container, options, nativeMenubar),
		);
		this.domNode.classList.add("ash-electron-titlebar");
		this._register(this.themeService.onDidColorThemeChange(() => this.updateStyles()));
		this.updateStyles();
	}

	public updateStyles(): void {
		const theme = this.themeService.getColorTheme();
		const backgroundColor = theme.getColorCss(titleBarBackground);
		const symbolColor = theme.getColorCss(titleBarActionForeground);
		if (!backgroundColor || !symbolColor) {
			throw new Error(`Theme '${theme.id}' does not define window control colors`);
		}
		void this.hostService.setWindowTheme({ backgroundColor, symbolColor }).catch((error: unknown) => {
			console.error("Failed to apply window control colors", error);
		});
	}
}

/**
 * Keeps the compact renderer menu on every platform and mirrors it into the
 * native macOS application menu.
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
	return (container, options, instantiationService) => instantiationService.createInstance(ElectronTitlebarPart, container, options, nativeMenubar);
}
