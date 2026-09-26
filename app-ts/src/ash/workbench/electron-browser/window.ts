import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import type { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { INativeHostApi } from '../../platform/native/common/nativeHost.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../platform/window/common/window.js';

/** Keeps one desktop window's zoom level in sync with its profile setting. */
export class NativeWindow extends Disposable {
	private pendingZoomLevel: number | undefined;
	private zoomWrite: Promise<void> = Promise.resolve();
	private applyingConfiguredZoom = false;

	constructor(
		private readonly host: INativeHostApi,
		private readonly configuration: IConfigurationService,
	) {
		super();
		const zoomSubscription = this.host.onDidChangeZoomLevel(level => {
			if (this.applyingConfiguredZoom) return;
			this.pendingZoomLevel = Math.round(level);
			this.zoomWrite = this.zoomWrite.catch(onUnexpectedError).then(async () => {
				const next = this.pendingZoomLevel;
				if (next === undefined) return;
				if (next !== this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING)) {
					await this.configuration.updateValue(WINDOW_ZOOM_LEVEL_SETTING, next);
				}
				if (this.pendingZoomLevel === next) this.pendingZoomLevel = undefined;
			});
			void this.zoomWrite.catch(onUnexpectedError);
		});
		this._register(toDisposable(() => zoomSubscription.dispose()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WINDOW_ZOOM_LEVEL_SETTING) && this.pendingZoomLevel === undefined) void this.applyConfiguredZoom().catch(onUnexpectedError);
		}));
		void this.applyConfiguredZoom().catch(onUnexpectedError);
	}

	private async applyConfiguredZoom(): Promise<void> {
		const level = this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING);
		if (await this.host.getZoomLevel() !== level) {
			this.applyingConfiguredZoom = true;
			try { await this.host.setZoomLevel(level); }
			finally { this.applyingConfiguredZoom = false; }
		}
	}
}
