import { addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { SyncDescriptor } from '../../instantiation/common/descriptors.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IMeteredConnectionService, METERED_CONNECTION_SETTING_KEY, type MeteredConnectionSettingValue, type NavigatorWithConnection, type NetworkInformation } from '../common/meteredConnection.js';
import '../common/meteredConnection.config.contribution.js';

/** Owns the effective policy for a Web page without an Electron main process. */
export class MeteredConnectionService extends Disposable implements IMeteredConnectionService {
	readonly _serviceBrand = undefined;
	private readonly changes = this._register(new Emitter<boolean>());
	readonly onDidChangeIsConnectionMetered = this.changes.event;
	private readonly connection: NetworkInformation | undefined;
	private metered: boolean;

	constructor(connectionProvider: () => NetworkInformation | undefined, @IConfigurationService private readonly configuration: IConfigurationService) {
		super();
		this.connection = connectionProvider();
		this.metered = this.readState();
		if (this.connection) this._register(addDisposableListener(this.connection, 'change', () => this.updateState()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(METERED_CONNECTION_SETTING_KEY)) this.updateState();
		}));
	}

	get isConnectionMetered(): boolean { return this.metered; }

	private readState(): boolean {
		const setting = this.configuration.getValue<MeteredConnectionSettingValue>(METERED_CONNECTION_SETTING_KEY);
		return setting === 'on' || setting === 'auto' && (this.connection?.saveData === true || this.connection?.metered === true);
	}

	private updateState(): void {
		const next = this.readState();
		if (this.metered === next) return;
		this.metered = next;
		this.changes.fire(next);
	}
}

registerSingleton(IMeteredConnectionService, new SyncDescriptor(MeteredConnectionService, [
	() => (navigator as NavigatorWithConnection).connection,
], true));
