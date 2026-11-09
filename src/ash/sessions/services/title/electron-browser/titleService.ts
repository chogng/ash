import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import type { TitlebarPartFactory } from '../../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { NativeMenubarControl } from '../../../../workbench/electron-browser/parts/titlebar/menubarControl.js';
import { bindWindowsTitlebarInsets, ElectronTitleService } from '../../../../workbench/electron-browser/parts/titlebar/titlebarPart.js';
import { ITitleService } from '../../../../workbench/services/title/browser/titleService.js';
import { Menus } from '../../../browser/menus.js';
import { TitlebarPart } from '../../../browser/parts/titlebarPart.js';

export function registerTitleService(container: HTMLElement, productName: string, services: InstantiationService, windowLifetime: DisposableStore): void {
	const createTitlebarPart: TitlebarPartFactory<TitlebarPart> = (root, _options, scope) => {
		if (isMacintosh) {
			// Publish this window's menu so focus never dispatches IDE-only actions here.
			windowLifetime.add(scope.createInstance(NativeMenubarControl, Menus.MenubarMainMenu));
		}
		const titlebar = scope.createInstance(TitlebarPart, root, isMacintosh ? 'actions-only' : 'application-menu');
		titlebar.domNode.classList.add('ash-electron-titlebar');
		windowLifetime.add(bindWindowsTitlebarInsets(titlebar.domNode));
		return titlebar;
	};
	services.registerSingleton(ITitleService, () =>
		services.createInstance(ElectronTitleService, container, productName, createTitlebarPart, undefined));
}
