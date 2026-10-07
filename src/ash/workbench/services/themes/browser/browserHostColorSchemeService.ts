import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IHostColorSchemeService } from '../common/hostColorSchemeService.js';

/** Owns the browser's appearance queries for one window. */
export class BrowserHostColorSchemeService extends Disposable implements IHostColorSchemeService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeColorScheme = this.changed.event;
	private readonly darkQuery: MediaQueryList;
	private readonly contrastQuery: MediaQueryList;

	constructor(ownerWindow: Window) {
		super();
		this.darkQuery = ownerWindow.matchMedia('(prefers-color-scheme: dark)');
		this.contrastQuery = ownerWindow.matchMedia('(forced-colors: active)');
		for (const query of [this.darkQuery, this.contrastQuery]) {
			const update = (): void => this.changed.fire();
			query.addEventListener('change', update);
			this._register(toDisposable(() => query.removeEventListener('change', update)));
		}
	}

	public get dark(): boolean { return this.darkQuery.matches; }
	public get highContrast(): boolean { return this.contrastQuery.matches; }
}
