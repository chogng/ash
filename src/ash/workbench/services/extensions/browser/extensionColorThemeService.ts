import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { ITextFileService } from '../../textfile/common/textfiles.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { WorkbenchThemesRegistry } from '../../../common/theme.js';
import { parseExtensionManifest, verifyExtensionManifestDigest } from '../common/extensionManifest.js';
import {
	createExtensionWorkbenchColorTheme,
	getDevelopmentThemeLocation,
	loadExtensionTheme,
} from '../common/extensionTheme.js';

/** Owns manifest-contributed color theme loading and registration for one renderer. */
export class ExtensionColorThemeService extends Disposable {
	private readonly registration = this._register(WorkbenchThemesRegistry.registerColorThemes([]));
	private loading: Promise<void> | undefined;
	private reloadQueued = false;
	private sourceFiles = new Set<string>();
	/** The window supplies checkout reads once its scoped text file service is available. */
	private textFiles: ITextFileService | undefined;
	private readonly sourceListener = this._register(new MutableDisposable());

	constructor(
		private readonly api: IExtensionApi,
		events: IServerEventApi,
		private readonly developmentThemeLocations: Readonly<Record<string, string>> | undefined = import.meta.env?.ASH_BUILTIN_THEME_SOURCES,
	) {
		super();
		let activationGeneration: number | undefined;
		let extensionManagementRevision: { readonly instanceId: string; readonly generation: number; } | undefined;
		const subscription = events.subscribe(event => {
			if (event.method === 'plugin/changed') {
				if (event.params.activationGeneration === activationGeneration) return;
				activationGeneration = event.params.activationGeneration;
			} else if (event.method === 'extensions/changed') {
				if (extensionManagementRevision?.instanceId === event.params.instanceId && event.params.generation <= extensionManagementRevision.generation) return;
				extensionManagementRevision = event.params;
			} else {
				return;
			}
			void this.reload().catch(error => console.error('Extension color theme refresh failed', error));
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	start(): Promise<void> {
		return this.reload();
	}

	/** Source saves refresh the existing registration owner, including included syntax files. */
	watchSourceSaves(files: ITextFileService): void {
		this.textFiles = files;
		this.sourceListener.value = files.onDidSave(event => {
			if (this.sourceFiles.has(event.resource.toString())) {
				void this.reload().catch(error => console.error('Extension color theme source refresh failed', error));
			}
		});
	}

	reload(): Promise<void> {
		this.reloadQueued = true;
		if (this.loading) return this.loading;
		const operation = this.drainReloads();
		this.loading = operation;
		void operation.then(() => {
			if (this.loading === operation) this.loading = undefined;
		}, () => {
			if (this.loading === operation) this.loading = undefined;
		});
		return operation;
	}

	private async drainReloads(): Promise<void> {
		let firstFailure: unknown;
		while (!this.isDisposed && this.reloadQueued) {
			this.reloadQueued = false;
			try { await this.loadAndRegister(); }
			catch (error) { firstFailure ??= error; }
		}
		if (firstFailure !== undefined && !this.isDisposed) throw firstFailure;
	}

	private async loadAndRegister(): Promise<void> {
		const catalog = await this.api.list('refresh');
		const themes: IColorTheme[] = [];
		const sourceFiles = new Set<string>();
		const loads: (() => Promise<IColorTheme>)[] = [];
		for (const extension of catalog.extensions) {
			await verifyExtensionManifestDigest(extension);
			if (this.isDisposed) return;
			const manifest = parseExtensionManifest(extension.manifestJson, extension);
			if (manifest.contributes.themes.length === 0) continue;
			const developmentRoot = getDevelopmentThemeLocation(extension.id, extension.sourceKind, this.developmentThemeLocations);
			const textFiles = this.textFiles;
			const packageRoot = extension.extensionLocation ? URI.parse(extension.extensionLocation) : undefined;
			const resources = new Map<string, Promise<Uint8Array>>();
			const sourceResources = new Map<string, Promise<Uint8Array>>();
			const readPackage = (path: string): Promise<Uint8Array> => {
				this.assertNotDisposed();
				if (packageRoot) sourceFiles.add(URI.joinPath(packageRoot, path).toString());
				let bytes = resources.get(path);
				if (!bytes) {
					bytes = this.api.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: extension.id, path });
					resources.set(path, bytes);
				}
				return bytes;
			};
			const readSource = developmentRoot && textFiles ? (path: string): Promise<Uint8Array> => {
				this.assertNotDisposed();
				const resource = URI.joinPath(developmentRoot, path);
				sourceFiles.add(resource.toString());
				if (packageRoot) sourceFiles.add(URI.joinPath(packageRoot, path).toString());
				let bytes = sourceResources.get(path);
				if (!bytes) {
					bytes = textFiles.resolve({ resource }, new AbortController().signal)
						.then(content => new TextEncoder().encode(content.text));
					sourceResources.set(path, bytes);
				}
				return bytes;
			} : undefined;
			for (const [index, contribution] of manifest.contributes.themes.entries()) {
				loads.push(async () => {
					const load = (read: (path: string) => Promise<Uint8Array>) => loadExtensionTheme(read, extension.id, contribution, index);
					if (readSource) {
						try {
							return createExtensionWorkbenchColorTheme(await load(readSource));
						} catch (error) {
							const code = error instanceof Error ? toFileSystemProviderErrorCode(error) : FileSystemProviderErrorCode.Unknown;
							if (code !== FileSystemProviderErrorCode.FileNotFound && code !== FileSystemProviderErrorCode.NoPermissions) throw error;
							// Resolve the whole theme again so checkout files and package includes never mix.
						}
					}
					return createExtensionWorkbenchColorTheme(await load(readPackage));
				});
			}
		}
		// Includes remain ordered within a theme; independent themes share a bounded
		// pool. Wait for admitted reads before reporting a failure or replacing state.
		const failures = new Map<number, unknown>();
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(8, loads.length) }, async () => {
			while (!this.isDisposed && failures.size === 0 && next < loads.length) {
				const index = next++;
				try { themes[index] = await loads[index]!(); }
				catch (error) { failures.set(index, error); }
			}
		}));
		if (this.isDisposed) return;
		if (failures.size) throw failures.get(Math.min(...failures.keys()));
		if (!this.isDisposed) {
			this.sourceFiles = sourceFiles;
			this.registration.replace(themes);
		}
	}
}
