import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IServerEventApi } from '../../../../platform/app-server/common/appServerApi.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { WorkbenchThemesRegistry } from '../../../common/theme.js';
import { parseExtensionManifest, verifyExtensionManifestDigest } from '../common/extensionManifest.js';
import { createExtensionWorkbenchColorTheme, loadExtensionTheme } from '../common/extensionTheme.js';

/** Registers declarative extension color themes in a renderer without an editor extension service. */
export class ExtensionColorThemeService extends Disposable {
	private readonly registration = this._register(WorkbenchThemesRegistry.registerColorThemes([]));
	private loading: Promise<void> | undefined;
	private reloadQueued = false;

	constructor(private readonly api: IExtensionApi, events: IServerEventApi) {
		super();
		let activationGeneration: number | undefined;
		const subscription = events.subscribe(event => {
			if (event.method !== 'plugin/changed' || event.params.activationGeneration === activationGeneration) return;
			activationGeneration = event.params.activationGeneration;
			void this.reload().catch(error => console.error('Extension color theme refresh failed', error));
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	start(): Promise<void> {
		return this.reload();
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
		const resources = new Map<string, Promise<Uint8Array>>();
		for (const extension of catalog.extensions) {
			await verifyExtensionManifestDigest(extension);
			const manifest = parseExtensionManifest(extension.manifestJson, extension);
			for (const [index, contribution] of manifest.contributes.themes.entries()) {
				const read = (path: string): Promise<Uint8Array> => {
					const key = `${extension.id}\0${path}`;
					let bytes = resources.get(key);
					if (!bytes) {
						bytes = this.api.readResource({ generation: catalog.generation, extensionId: extension.id, path });
						resources.set(key, bytes);
					}
					return bytes;
				};
				const definition = await loadExtensionTheme(read, extension.id, contribution, index);
				themes.push(createExtensionWorkbenchColorTheme(definition));
			}
		}
		if (!this.isDisposed) this.registration.replace(themes);
	}
}
