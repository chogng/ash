import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IColorTheme } from '../../common/colorTheme.js';
import type { IThemeService } from '../../common/themeService.js';

export class TestThemeService extends Disposable implements IThemeService {
	private readonly changed = this._register(new Emitter<IColorTheme>());
	public readonly onDidColorThemeChange = this.changed.event;

	constructor(private theme: IColorTheme) { super(); }

	public getColorTheme(): IColorTheme { return this.theme; }

	public setColorTheme(theme: IColorTheme): void {
		if (theme === this.theme) { return; }
		this.theme = theme;
		this.changed.fire(theme);
	}
}
