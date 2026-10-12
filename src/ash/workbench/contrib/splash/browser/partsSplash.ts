import { Disposable } from '../../../../base/common/lifecycle.js';
import { Color } from '../../../../base/common/color.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ISplashStorageService, removePartsSplash } from './splash.js';

/** Captures the live owners' rendering state after restoration, and retires the startup DOM. */
export class PartsSplash extends Disposable {
	static readonly ID = 'workbench.contrib.partsSplash';

	constructor(
		@IThemeService private readonly themeService: IThemeService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ISplashStorageService private readonly storage: ISplashStorageService,
	) {
		super();
		this._register(layoutService.onDidLayoutMainContainer(dimension => {
			if (dimension.width > 0 && dimension.height > 0) {
				removePartsSplash(layoutService.mainContainer.ownerDocument);
			}
		}));
		this._register(themeService.onDidColorThemeChange(() => {
			if (lifecycleService.phase >= LifecyclePhase.Restored) this.save();
		}));
		void lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (!this.isDisposed) this.save();
		});
	}

	private save(): void {
		const theme = this.themeService.getColorTheme();
		const background = theme.getColor('workbench.background') ?? theme.getColor('editor.background');
		const foreground = theme.getColor('foreground');
		if (!background || !foreground) return;
		void this.storage.saveWindowSplash({
			baseTheme: theme.colorScheme,
			colorInfo: {
				background: Color.Format.CSS.formatHex(background),
				foreground: Color.Format.CSS.formatHex(foreground),
			},
		}).catch(error => console.error('Could not save startup rendering state', error));
	}
}
