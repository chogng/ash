import type { INativeMenubarApi } from '../../../../platform/menubar/common/nativeMenubar.js';
import type { TitlebarPartFactory } from '../../../browser/parts/titlebar/titlebarPart.js';
import { NativeTitlebarPart } from '../../../electron-browser/parts/titlebar/titlebarPart.js';

/** Selects Electron's window controls and application menu for the shared title service. */
export function createElectronTitlebarPartFactory(nativeMenubar: INativeMenubarApi): TitlebarPartFactory {
	return (container, options, instantiationService) => instantiationService.createInstance(NativeTitlebarPart, container, options, nativeMenubar);
}
