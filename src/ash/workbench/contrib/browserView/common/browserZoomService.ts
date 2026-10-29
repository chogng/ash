import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { isRecord } from '../../../../base/common/types.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { browserZoomDefaultIndex, browserZoomFactors } from '../../../../platform/browserView/common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export const MATCH_WINDOW_ZOOM_LABEL = 'Match Window';

export const IBrowserZoomService = createServiceIdentifier<IBrowserZoomService>('browserZoomService');
export interface IBrowserZoomChangeEvent {
	readonly host: string | undefined;
	readonly isInMemoryChange: boolean;
}
export interface IBrowserZoomService {
	readonly onDidChangeZoom: Event<IBrowserZoomChangeEvent>;
	getEffectiveZoomIndex(host: string | undefined, isInMemory: boolean): number;
	setHostZoomIndex(host: string, zoomIndex: number, isInMemory: boolean): void;
	notifyWindowZoomChanged(windowZoomFactor: number): void;
}

const storageKey = 'browserView.zoomPerHost';

/** One window owner for host preferences; ephemeral pages never write persistent zoom overrides. */
export class BrowserZoomService extends Disposable implements IBrowserZoomService {
	private readonly ephemeral = new Map<string, number>();
	private readonly changed = this._register(new Emitter<IBrowserZoomChangeEvent>());
	public readonly onDidChangeZoom = this.changed.event;
	private windowZoomIndex = browserZoomDefaultIndex;
	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === storageKey) {
					this.changed.fire({ host: undefined, isInMemoryChange: false });
				}
			}),
		);
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('workbench.browser.pageZoom')) {
					this.changed.fire({ host: undefined, isInMemoryChange: false });
				}
			}),
		);
	}
	private get defaultIndex(): number {
		const label = this.configuration.getValue<string>('workbench.browser.pageZoom');
		return label === MATCH_WINDOW_ZOOM_LABEL ? this.windowZoomIndex : browserZoomFactors.findIndex(factor => `${Math.round(factor * 100)}%` === label);
	}
	public notifyWindowZoomChanged(windowZoomFactor: number): void {
		const index = browserZoomFactors.reduce<number>(
			(best, factor, candidate) => (Math.abs(factor - windowZoomFactor) < Math.abs(browserZoomFactors[best]! - windowZoomFactor) ? candidate : best),
			browserZoomDefaultIndex,
		);
		if (index === this.windowZoomIndex) {
			return;
		}
		this.windowZoomIndex = index;
		if (this.configuration.getValue<string>('workbench.browser.pageZoom') === MATCH_WINDOW_ZOOM_LABEL) {
			this.changed.fire({ host: undefined, isInMemoryChange: false });
		}
	}
	private read(): Record<string, number> {
		const raw = this.storage.get(storageKey, StorageScope.PROFILE);
		if (!raw) {
			return {};
		}
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || Object.values(parsed).some(value => !Number.isInteger(value) || (value as number) < 0 || (value as number) >= browserZoomFactors.length)) {
			throw new TypeError('Invalid browser zoom preferences');
		}
		return parsed as Record<string, number>;
	}
	public getEffectiveZoomIndex(host: string | undefined, isInMemory: boolean): number {
		if (!host) {
			return this.defaultIndex;
		}
		if (isInMemory) {
			return this.ephemeral.get(host) ?? this.defaultIndex;
		}
		const values = this.read();
		return Object.hasOwn(values, host) ? values[host]! : this.defaultIndex;
	}
	public setHostZoomIndex(host: string, zoomIndex: number, isInMemory: boolean): void {
		if (zoomIndex === this.defaultIndex) {
			this.ephemeral.delete(host);
		} else {
			this.ephemeral.set(host, zoomIndex);
		}
		if (!isInMemory) {
			const values = this.read();
			if (zoomIndex === this.defaultIndex) {
				delete values[host];
			} else {
				Object.defineProperty(values, host, {
					value: zoomIndex,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
			this.storage.store(storageKey, JSON.stringify(values), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		this.changed.fire({ host, isInMemoryChange: isInMemory });
	}
}
