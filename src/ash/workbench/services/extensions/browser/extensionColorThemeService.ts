import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { ITextFileService } from '../../textfile/common/textfiles.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { WorkbenchThemesRegistry } from '../../../common/theme.js';
import { parseExtensionManifest, verifyExtensionManifestDigest } from '../common/extensionManifest.js';
import { createExtensionWorkbenchColorTheme, loadExtensionTheme } from '../common/extensionTheme.js';

/** Owns manifest-contributed color theme loading and registration for one renderer. */
export class ExtensionColorThemeService extends Disposable {
	private readonly registration = this._register(WorkbenchThemesRegistry.registerColorThemes([]));
	private loading: Promise<void> | undefined;
	private reloadQueued = false;
	private sourceFiles = new Set<string>();
	private readonly sourceListener = this._register(new MutableDisposable());

	constructor(
		private readonly api: IExtensionApi,
		events: IServerEventApi,
	) {
		super();
		let activationGeneration: number | undefined;
		let extensionManagementRevision: { readonly instanceId: string; readonly generation: number } | undefined;
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
		void operation.then(
			() => {
				if (this.loading === operation) this.loading = undefined;
			},
			() => {
				if (this.loading === operation) this.loading = undefined;
			},
		);
		return operation;
	}

	private async drainReloads(): Promise<void> {
		let firstFailure: unknown;
		while (!this.isDisposed && this.reloadQueued) {
			this.reloadQueued = false;
			try {
				await this.loadAndRegister();
			} catch (error) {
				firstFailure ??= error;
			}
		}
		if (firstFailure !== undefined && !this.isDisposed) throw firstFailure;
	}

	private async loadAndRegister(): Promise<void> {
		const catalog = await this.api.list('refresh');
		const themes: IColorTheme[] = [];
		const resources = new Map<string, Promise<Uint8Array>>();
		const sourceFiles = new Set<string>();
		const loads: (() => Promise<IColorTheme>)[] = [];
		for (const extension of catalog.extensions) {
			await verifyExtensionManifestDigest(extension);
			if (this.isDisposed) return;
			const manifest = parseExtensionManifest(extension.manifestJson, extension);
			for (const [index, contribution] of manifest.contributes.themes.entries()) {
				loads.push(async () => {
					const read = (path: string): Promise<Uint8Array> => {
						this.assertNotDisposed();
						if (extension.extensionLocation) sourceFiles.add(URI.joinPath(URI.parse(extension.extensionLocation), path).toString());
						const key = `${extension.id}\0${path}`;
						let bytes = resources.get(key);
						if (!bytes) {
							bytes = this.api.resources.readExtensionResourceBytes({
								generation: catalog.generation,
								extensionId: extension.id,
								path,
							});
							resources.set(key, bytes);
						}
						return bytes;
					};
					return createExtensionWorkbenchColorTheme(await loadExtensionTheme(read, extension.id, contribution, index));
				});
			}
		}
		// Includes remain ordered within a theme; independent themes share a bounded
		// pool. Wait for admitted reads before reporting a failure or replacing state.
		const failures = new Map<number, unknown>();
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(8, loads.length) }, async () => {
				while (!this.isDisposed && failures.size === 0 && next < loads.length) {
					const index = next++;
					try {
						themes[index] = await loads[index]!();
					} catch (error) {
						failures.set(index, error);
					}
				}
			}),
		);
		if (this.isDisposed) return;
		if (failures.size) throw failures.get(Math.min(...failures.keys()));
		if (!this.isDisposed) {
			this.sourceFiles = sourceFiles;
			this.registration.replace(themes);
		}
	}
}
