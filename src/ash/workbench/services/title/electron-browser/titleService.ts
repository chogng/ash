import type { TitlebarPartFactory } from '../../../browser/parts/titlebar/titlebarPart.js';
import { NativeTitlebarPart } from '../../../electron-browser/parts/titlebar/titlebarPart.js';

/** Selects Electron's window controls and application menu for the shared title service. */
export function createElectronTitlebarPartFactory(): TitlebarPartFactory {
	return (container, options, instantiationService) =>
		instantiationService.createInstance(NativeTitlebarPart, container, options);
}
