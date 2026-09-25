import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Colors } from '../../common/colorRegistry.js';
import { defaultProductIconTheme, type IColorTheme, type IThemeService } from '../../common/themeService.js';

export class TestThemeService extends Disposable implements IThemeService {
	private readonly changed = this._register(new Emitter<IColorTheme>());
	public readonly onDidColorThemeChange = this.changed.event;
	public readonly onDidProductIconThemeChange = Event.None;

	constructor(private theme: IColorTheme) {
		super();
		this._register(Colors.onDidChange(() => this.changed.fire(this.theme)));
	}

	public getColorTheme(): IColorTheme { return this.theme; }
	public getProductIconTheme() { return defaultProductIconTheme; }

	public setColorTheme(theme: IColorTheme): void {
		if (theme === this.theme) { return; }
		this.theme = theme;
		this.changed.fire(theme);
	}
}
