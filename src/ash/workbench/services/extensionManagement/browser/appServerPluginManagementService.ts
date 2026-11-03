import { installAgentPluginFromRepository } from './agentPluginRepositoryService.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IPluginManagementApi } from '../../../../platform/extensionManagement/common/pluginManagementApi.js';
import type { IPluginManagementService, PluginCatalogView, PluginInstallation, PluginPackageView } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { ILocalGitService } from '../../../../platform/git/common/localGitService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { canceled } from '../../../../base/common/errors.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ExtensionUiTarget } from '../../../../platform/extensionManagement/common/extensionManagementService.js';

export class AppServerPluginManagementService extends Disposable implements IPluginManagementService {
	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange = this._onDidChange.event;
	private readonly gitInstalls = this._register(new DisposableStore());

	constructor(
		private readonly api: IPluginManagementApi,
		events: IServerEventApi,
		@ILocalGitService private readonly git: ILocalGitService,
		@IFileService private readonly files: IFileService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === 'plugin/changed') this._onDidChange.fire(event.params.revision);
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async list(): Promise<PluginCatalogView> {
		const catalog = await this.api.list();
		return { ...catalog, packages: catalog.packages.map(({ uiTargets, ...plugin }) => ({ ...plugin, ...(uiTargets ? { uiTargets: uiTargets.map(target => target === 'ide' ? ExtensionUiTarget.IDE : ExtensionUiTarget.Agents) } : {}) })) };
	}

	async installLocal(path: string, expectedRevision: number): Promise<PluginInstallation> {
		const result = await this.api.installLocal({ commandId: `desktop-plugin-install-${crypto.randomUUID()}`, expectedRevision, path, dirId: null });
		return { id: result.id, version: result.version, digest: result.digest };
	}

	async installFromGit(
		folder: IWorkspaceFolder,
		url: string,
		reference: string | undefined,
		packagePath: string,
		signal: AbortSignal,
	): Promise<PluginInstallation> {
		const controller = new AbortController();
		const lifetime = this.gitInstalls.add(toDisposable(() => controller.abort()));
		try {
			const lifetimeSignal = AbortSignal.any([signal, controller.signal]);
			return await installAgentPluginFromRepository({ folder, url, reference, packagePath, signal: lifetimeSignal }, this.git, this.files, this.log, async (packageName, operationId) => {
				// Bind installation to the captured folder even if the workspace changed while cloning.
				const catalog = await this.api.list();
				if (lifetimeSignal.aborted) { throw canceled(); }
				const result = await this.api.installLocal({
					commandId: `desktop-plugin-git-${operationId}`,
					expectedRevision: catalog.revision,
					path: packageName,
					dirId: folder.id,
				});
				return { id: result.id, version: result.version, digest: result.digest };
			});
		} finally {
			this.gitInstalls.delete(lifetime);
			lifetime.dispose();
		}
	}

	async enable(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.enable(command('enable', plugin, revision));
	}

	async disable(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.disable(command('disable', plugin, revision));
	}

	async grant(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.grant(command('grant', plugin, revision));
	}

	async revokeGrant(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.revokeGrant(command('revoke', plugin, revision));
	}

	async uninstall(plugin: PluginPackageView, revision: number): Promise<void> {
		await this.api.uninstall(command('uninstall', plugin, revision));
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
