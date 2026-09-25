import './media/window.css';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { localize } from '../../nls.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import type { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { INativeHostApi } from '../../platform/native/common/nativeHost.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../platform/window/common/window.js';
import { StatusbarAlignment, type IStatusbarEntryAccessor, type IStatusbarService } from '../services/statusbar/browser/statusbar.js';

/** Keeps one desktop window's zoom indicator in sync with Electron. */
export class NativeWindow extends Disposable {
	private readonly status: IStatusbarEntryAccessor;
	private pendingZoomLevel: number | undefined;
	private zoomWrite: Promise<void> = Promise.resolve();
	private applyingConfiguredZoom = false;

	constructor(
		private readonly host: INativeHostApi,
		statusbar: IStatusbarService,
		private readonly commands: ICommandService,
		private readonly configuration: IConfigurationService,
	) {
		super();
		this.status = this._register(statusbar.addEntry(this.entry(0), {
			id: 'ash.status.zoom',
			alignment: StatusbarAlignment.Right,
			priority: 100,
		}));
		const zoomSubscription = this.host.onDidChangeZoomLevel(level => {
			this.update(level);
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
		this.update(level);
	}

	private update(level: number): void {
		if (!this.isDisposed) this.status.update(this.entry(level));
	}

	private entry(level: number) {
		const percent = `${Math.round(100 * Math.pow(1.2, level))}%`;
		return {
			text: percent,
			ariaLabel: localize({ bundle: 'ash', key: 'workbench.zoomStatus' }, 'Zoom {0}; activate to reset', percent),
			tooltip: localize({ bundle: 'ash', key: 'workbench.zoomStatus' }, 'Zoom {0}; activate to reset', percent),
			run: () => this.commands.executeCommand('workbench.action.zoomReset'),
		};
	}
}
