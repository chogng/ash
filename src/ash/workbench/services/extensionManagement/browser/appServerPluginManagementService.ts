import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IPluginManagementApi } from '../../../../platform/extensionManagement/common/pluginManagementApi.js';
import type { IPluginManagementService, PluginCatalogView, PluginInstallation, PluginPackageView } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { ILocalGitService } from '../../../../platform/git/common/localGitService.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { canceled } from '../../../../base/common/errors.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
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
		return {
			...catalog,
			packages: catalog.packages.map(({ uiTargets, ...plugin }) => ({
				...plugin,
				...(uiTargets
					? {
							uiTargets: uiTargets.map(target => (target === 'ide' ? ExtensionUiTarget.IDE : ExtensionUiTarget.Agents)),
						}
					: {}),
			})),
		};
	}

	async installLocal(path: string, expectedRevision: number): Promise<PluginInstallation> {
		const result = await this.api.installLocal({
			commandId: `desktop-plugin-install-${crypto.randomUUID()}`,
			expectedRevision,
			path,
			dirId: null,
		});
		return { id: result.id, version: result.version, digest: result.digest };
	}

	async installFromGit(folder: IWorkspaceFolder, url: string, reference: string | undefined, packagePath: string, signal: AbortSignal): Promise<PluginInstallation> {
		const controller = new AbortController();
		const lifetime = this.gitInstalls.add(toDisposable(() => controller.abort()));
		try {
			return await this.installGitPackage(folder, url, reference, packagePath, AbortSignal.any([signal, controller.signal]));
		} finally {
			this.gitInstalls.delete(lifetime);
			lifetime.dispose();
		}
	}

	private async installGitPackage(folder: IWorkspaceFolder, url: string, reference: string | undefined, packagePath: string, signal: AbortSignal): Promise<PluginInstallation> {
		// Validate the user-entered package path before joining it to any host resource.
		const parts = packagePath === '' || packagePath === '.' ? [] : packagePath.split('/');
		if (parts.some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'invalidGitPackagePath' }, 'Enter a package path within the repository, using forward slashes.'));
		}
		const operationId = crypto.randomUUID();
		const checkoutName = `ash-plugin-checkout-${operationId}`;
		const packageName = `ash-plugin-package-${operationId}`;
		const checkout = URI.joinPath(folder.uri, checkoutName);
		const staging = URI.joinPath(folder.uri, packageName);
		const targetPath = isRemoteResource(checkout) ? getRemoteWorkspacePath(checkout) : checkout.fsPath;
		if (signal.aborted) {
			throw canceled();
		}
		const cancel = () => {
			void this.git.cancel(operationId).catch(() => undefined);
		};
		signal.addEventListener('abort', cancel, { once: true });
		try {
			await this.git.clone(operationId, url, targetPath, reference);
		} finally {
			signal.removeEventListener('abort', cancel);
		}
		if (signal.aborted) {
			throw canceled();
		}
		let source = checkout;
		for (const part of parts) {
			source = URI.joinPath(source, part);
			if ((await this.files.stat(source)).kind !== FileKind.Directory) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'unsafeGitPackageEntry' }, 'The package contains a symbolic link or unsupported file: {0}', part));
			}
		}
		await this.files.createDirectory(staging);
		try {
			// Git configuration, credentials and hooks are checkout metadata, never package bytes.
			await this.copyGitPackage(source, staging, signal);
			if (signal.aborted) {
				throw canceled();
			}
			// Bind installation to the captured folder, even if the active workspace changed while cloning.
			const catalog = await this.api.list();
			if (signal.aborted) {
				throw canceled();
			}
			const result = await this.api.installLocal({
				commandId: `desktop-plugin-git-${operationId}`,
				expectedRevision: catalog.revision,
				path: packageName,
				dirId: folder.id,
			});
			await this.removeGitStaging(checkout);
			return { id: result.id, version: result.version, digest: result.digest };
		} finally {
			await this.removeGitStaging(staging);
		}
	}

	private async copyGitPackage(source: URI, destination: URI, signal: AbortSignal): Promise<void> {
		for (const entry of await this.files.readDirectory(source)) {
			if (signal.aborted) {
				throw canceled();
			}
			if (entry.name.toLowerCase() === '.git') {
				continue;
			}
			const target = URI.joinPath(destination, entry.name);
			if (entry.kind === FileKind.Directory) {
				await this.files.createDirectory(target);
				await this.copyGitPackage(entry.resource, target, signal);
			} else if (entry.kind === FileKind.File) {
				await this.files.copy(entry.resource, target);
			} else {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'unsafeGitPackageEntry' }, 'The package contains a symbolic link or unsupported file: {0}', entry.name));
			}
		}
	}

	private async removeGitStaging(resource: URI): Promise<void> {
		try {
			await this.files.delete(resource, 'ignore', 'recursive');
		} catch (error) {
			// Cleanup failure cannot turn an already committed installation into an apparent failure.
			this.log.warn('extensions', 'Unable to remove Git installation staging', error);
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
