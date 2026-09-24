import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { IPluginApi } from "../../../../platform/plugins/common/pluginApi.js";
import type { IPluginService, PluginCatalogView, PluginPackageView } from "../../../../platform/plugins/common/pluginService.js";

export class AppServerPluginService extends Disposable implements IPluginService {
	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly api: IPluginApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === "plugin/changed") this._onDidChange.fire(event.params.revision);
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async list(): Promise<PluginCatalogView> {
		return this.api.list();
	}

	async enable(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.enable(command("enable", plugin, revision));
	}

	async disable(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.disable(command("disable", plugin, revision));
	}

	async grant(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.grant(command("grant", plugin, revision));
	}

	async revokeGrant(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.revokeGrant(command("revoke", plugin, revision));
	}

	async uninstall(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.uninstall(command("uninstall", plugin, revision));
	}
}

function command(action: string, plugin: PluginPackageView, expectedRevision: number) {
	return {
		commandId: `desktop-plugin-${action}-${crypto.randomUUID()}`,
		expectedRevision,
		id: plugin.id,
		version: plugin.version,
		digest: plugin.digest,
	};
}
