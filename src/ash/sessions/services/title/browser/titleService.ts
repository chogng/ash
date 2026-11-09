import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { BrowserTitleService, type TitlebarPartFactory } from '../../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { ITitleService } from '../../../../workbench/services/title/browser/titleService.js';
import { TitlebarPart } from '../../../browser/parts/titlebarPart.js';

export function registerTitleService(container: HTMLElement, productName: string, services: InstantiationService): void {
	const createTitlebarPart: TitlebarPartFactory<TitlebarPart> = (root, _options, scope) =>
		scope.createInstance(TitlebarPart, root, 'application-menu');
	services.registerSingleton(ITitleService, () =>
		services.createInstance(BrowserTitleService, container, productName, createTitlebarPart, undefined));
}
