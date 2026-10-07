import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { getIconRegistry } from '../common/iconRegistry.js';
import type { IThemeService } from '../common/themeService.js';

/** Binds product theme fonts and extension icon fonts to one document. */
export class IconsStyleSheet extends Disposable {
	constructor(document: Document, themeService: IThemeService) {
		super();
		const style = document.createElement('style');
		style.setAttribute('data-ash-icon-fonts', '');
		document.head.append(style);
		this._register(toDisposable(() => style.remove()));
		const update = (): void => {
			style.textContent = [...getIconRegistry().getFonts(), ...themeService.getProductIconTheme().fonts ?? []]
				.map(font => `@font-face{font-family:"${font.id}";src:${font.src};font-style:${font.style ?? 'normal'};font-weight:${font.weight ?? 'normal'};font-display:block;}`).join('\n');
		};
		this._register(themeService.onDidProductIconThemeChange(update));
		this._register(getIconRegistry().onDidChange(update));
		update();
	}
}
