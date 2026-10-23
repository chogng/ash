import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color } from '../../../../base/common/color.js';
import { IThemeService, type IPartsSplash } from '../../../../platform/theme/common/themeService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ISplashStorageService, removePartsSplash } from './splash.js';

/** Captures the live owners' rendering state after restoration, and retires the startup DOM. */
export class PartsSplash extends Disposable {
	static readonly ID = 'workbench.contrib.partsSplash';
	private readonly saveSoon = this._register(new RunOnceScheduler(() => { void this.save(); }, 100));

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
				if (lifecycleService.phase >= LifecyclePhase.Restored) this.saveSoon.schedule();
			}
		}));
		this._register(themeService.onDidColorThemeChange(() => {
			if (lifecycleService.phase >= LifecyclePhase.Restored) this.saveSoon.schedule();
		}));
		this._register(toDisposable(() => removePartsSplash(layoutService.mainContainer.ownerDocument)));
		this._register(lifecycleService.onWillShutdown(event => {
			if (lifecycleService.phase >= LifecyclePhase.Restored) {
				this.saveSoon.cancel();
				event.join(this.save(), 'Startup rendering cache');
			}
		}));
		void lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (!this.isDisposed) void this.save();
		});
	}

	private save(): Promise<void> {
		const theme = this.themeService.getColorTheme();
		const background = theme.getColor('workbench.background') ?? theme.getColor('editor.background');
		const foreground = theme.getColor('foreground');
		if (!background || !foreground) return Promise.resolve();
		return this.storage.saveWindowSplash({
			baseTheme: theme.colorScheme,
			colorInfo: {
				background: Color.Format.CSS.formatHex(background),
				foreground: Color.Format.CSS.formatHex(foreground),
			},
			...this.captureLayout(background),
		}).catch(error => console.error('Could not save startup rendering state', error));
	}

	private captureLayout(background: Color): Pick<IPartsSplash, 'layoutInfo'> {
		const root = this.layoutService.mainContainer;
		const ownerWindow = root.ownerDocument.defaultView;
		if (!ownerWindow || ownerWindow.innerWidth <= 0 || ownerWindow.innerHeight <= 0) return {};
		const partBounds: NonNullable<IPartsSplash['layoutInfo']>['partBounds'][number][] = [];
		// Part creates these shell nodes; the layout owner places them before publishing its event.
		for (const element of root.querySelectorAll<HTMLElement>('.ash-workbench-part')) {
			if (element.hidden || element.parentElement?.closest('.ash-workbench-part')) continue;
			const rect = element.getBoundingClientRect();
			const left = Math.max(0, rect.left);
			const top = Math.max(0, rect.top);
			const width = Math.min(ownerWindow.innerWidth, rect.right) - left;
			const height = Math.min(ownerWindow.innerHeight, rect.bottom) - top;
			if (width <= 0 || height <= 0) continue;
			const style = ownerWindow.getComputedStyle(element);
			if (style.visibility === 'hidden') continue;
			const fill = Color.Format.CSS.parse(style.backgroundColor)?.flatten(background) ?? background;
			const borders = ['top', 'right', 'bottom', 'left'].map(side => ({
				width: Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0,
				color: Color.Format.CSS.formatHex(Color.Format.CSS.parse(style.getPropertyValue(`border-${side}-color`))?.flatten(fill) ?? fill),
				style: style.getPropertyValue(`border-${side}-style`) || 'none',
			}));
			const borderRadii = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((corner): readonly [number, number] => {
				const [horizontal, vertical = horizontal] = (style.getPropertyValue(`border-${corner}-radius`) || '0').split(/\s+/);
				// Computed radii may retain percentages. Resolve each axis against the original border box;
				// the browser applies the shared overlap reduction when drawing all four corners.
				const resolve = (value: string, size: number): number => (Number.parseFloat(value) || 0) * (value.endsWith('%') ? size / 100 : 1);
				return [resolve(horizontal, rect.width), resolve(vertical, rect.height)];
			});
			partBounds.push({
				left, top, width, height,
				background: Color.Format.CSS.formatHex(fill),
				...captureBackgroundGradient(style.backgroundImage, rect.width, rect.height, fill),
				borderRadii, borders,
			});
		}
		return partBounds.length ? { layoutInfo: { version: 2, width: ownerWindow.innerWidth, height: ownerWindow.innerHeight, partBounds } } : {};
	}
}

/** Keep only resolved paint data, rather than persisting CSS that could load external resources. */
function captureBackgroundGradient(image: string, width: number, height: number, background: Color): Pick<NonNullable<IPartsSplash['layoutInfo']>['partBounds'][number], 'backgroundGradient'> {
	const gradient = /^linear-gradient\((to right|to bottom|to left|to top|-?[\d.]+deg),\s*(.*)\)$/.exec(image);
	if (!gradient) return {};
	const directions: Readonly<Record<string, number>> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
	const angle = ((directions[gradient[1]] ?? Number.parseFloat(gradient[1])) % 360 + 360) % 360;
	const radians = angle * Math.PI / 180;
	const length = Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
	const stops: { color: string; offset: number; }[] = [];
	// Computed rgb()/rgba() colors contain commas of their own, but no nested functions.
	for (const entry of gradient[2].split(/,(?![^()]*\))/)) {
		const stop = /^\s*(rgba?\([^)]*\)|#[\da-f]+|[a-z]+)\s+(-?[\d.]+(?:px|%))(?:\s+(-?[\d.]+(?:px|%)))?\s*$/i.exec(entry);
		const color = stop && Color.Format.CSS.parse(stop[1]);
		if (!stop || !color) return {};
		for (const position of stop.slice(2).filter((value): value is string => value !== undefined)) {
			const offset = Number.parseFloat(position) * (position.endsWith('%') ? length / 100 : 1);
			// CSS fixes decreasing stop positions to the preceding stop (e.g. a collapsed sidebar).
			stops.push({ color: Color.Format.CSS.formatHex(color.flatten(background)), offset: Math.max(stops.at(-1)?.offset ?? offset, offset) });
		}
	}
	return stops.length >= 2 && stops.length <= 32 ? { backgroundGradient: { angle, stops } } : {};
}
