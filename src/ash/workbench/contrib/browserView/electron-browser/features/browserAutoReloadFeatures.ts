import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../nls.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { IBrowserViewWorkbenchService, type IBrowserViewModel } from '../../common/browserView.js';

const settingId = 'workbench.browser.autoReloadOnFileChange';
export const IBrowserAutoReloadService = createServiceIdentifier<IBrowserAutoReloadService>('browserAutoReloadService');
export interface IBrowserAutoReloadService {
	readonly onDidChangeState: Event<void>;
	isEnabled(id: string): boolean;
	canReload(id: string): boolean;
	toggle(id: string): void;
}

/** One watcher per live page; switching editors and splitting panes do not change its lifetime. */
export class BrowserAutoReloadWatcher extends Disposable {
	private readonly watches = this._register(new DisposableStore());
	private readonly reload = this._register(
		new RunOnceScheduler(() => {
			if (!this.isDisposed && this.enabled) {
				void this.model.reload().catch(onUnexpectedError);
			}
		}, 250),
	);
	private enabled = false;
	private watchedUrl: string | undefined;
	private watchSignature: string | undefined;
	constructor(
		private readonly model: IBrowserViewModel,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(
			model.onDidChangeState(() => {
				if (this.watchedUrl !== model.state.url) {
					this.update(this.enabled);
				}
			}),
		);
		this._register(model.onWillDispose(() => this.dispose()));
		this._register(workspace.onDidChangeWorkspace(() => this.update(this.enabled)));
	}
	public canReload(): boolean {
		const url = new URL(this.model.state.url);
		return this.model.info.owner.type === 'user' && (url.protocol === 'file:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
	}
	public update(enabled: boolean): void {
		const signature = JSON.stringify([enabled, this.model.state.url, this.workspace.getWorkspace().folders.map(folder => folder.uri.toString())]);
		if (signature === this.watchSignature) {
			return;
		}
		this.watchSignature = signature;
		this.enabled = enabled;
		this.watchedUrl = this.model.state.url;
		this.watches.clear();
		this.reload.cancel();
		if (!enabled || !this.canReload() || this.isDisposed) {
			return;
		}
		const url = new URL(this.model.state.url);
		const resources = url.protocol === 'file:' ? [URI.parse(url.href).with({ query: '', fragment: '' })] : this.workspace.getWorkspace().folders.map(folder => folder.uri);
		try {
			for (const resource of resources) {
				this.watches.add(this.files.watch(resource, { recursive: url.protocol !== 'file:', excludes: [] }));
			}
			this.watches.add(
				this.files.onDidChangeFiles(event => {
					if (
						!event.resources ||
						event.resources.some(changed => resources.some(resource => (url.protocol === 'file:' ? extUri.isEqual(changed, resource) : extUri.isEqualOrParent(changed, resource))))
					) {
						this.reload.schedule();
					}
				}),
			);
		} catch (error) {
			this.watches.clear();
			onUnexpectedError(error);
		}
	}
}

export class BrowserAutoReloadService extends Disposable implements IBrowserAutoReloadService {
	private readonly watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly active = new Map<string, BrowserAutoReloadWatcher>();
	private readonly overrides = new Map<string, boolean>();
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeState = this.changed.event;
	constructor(
		@IBrowserViewWorkbenchService private readonly browsers: IBrowserViewWorkbenchService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		this._register(browsers.onDidChangeBrowserViews(() => this.refresh()));
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(settingId)) {
					this.update();
				}
			}),
		);
		this._register(
			workspace.onDidChangeWorkspace(() => {
				for (const [id, input] of browsers.getKnownBrowserViews()) {
					if (input.model && new URL(input.model.state.url).protocol !== 'file:') {
						this.overrides.set(id, false);
					}
				}
				this.update();
			}),
		);
		void browsers
			.initialize()
			.then(() => this.refresh())
			.catch(onUnexpectedError);
	}
	private refresh(): void {
		if (this.isDisposed) {
			return;
		}
		const known = this.browsers.getKnownBrowserViews();
		for (const id of this.watchers.keys()) {
			if (!known.has(id)) {
				this.watchers.deleteAndDispose(id);
				this.active.delete(id);
				this.overrides.delete(id);
			}
		}
		for (const [id, input] of known) {
			if (this.watchers.has(id)) {
				continue;
			}
			const lifetime = new DisposableStore();
			const binding = lifetime.add(new DisposableStore());
			const attach = (): void => {
				binding.clear();
				this.active.delete(id);
				const model = input.model;
				if (!model) {
					return;
				}
				const watcher = binding.add(this.instantiation.createInstance(BrowserAutoReloadWatcher, model));
				this.active.set(id, watcher);
				watcher.update(this.isEnabled(id));
				let url = model.state.url;
				binding.add(
					model.onDidChangeState(() => {
						if (url === model.state.url) {
							return;
						}
						url = model.state.url;
						watcher.update(this.isEnabled(id));
						this.changed.fire();
					}),
				);
			};
			this.watchers.set(id, lifetime);
			lifetime.add(input.onDidResolveModel(attach));
			attach();
		}
		this.changed.fire();
	}
	private update(): void {
		for (const [id, watcher] of this.active) {
			watcher.update(this.isEnabled(id));
		}
		this.changed.fire();
	}
	public isEnabled(id: string): boolean {
		const model = this.browsers.getKnownBrowserViews().get(id)?.model;
		return this.overrides.get(id) ?? (!!model && new URL(model.state.url).protocol === 'file:' && this.configuration.getValue<boolean>(settingId));
	}
	public canReload(id: string): boolean {
		return this.active.get(id)?.canReload() ?? false;
	}
	public toggle(id: string): void {
		this.overrides.set(id, !this.isEnabled(id));
		this.update();
	}
}

registerSingleton(IBrowserAutoReloadService, BrowserAutoReloadService, InstantiationType.Delayed);
registerWorkbenchContribution('workbench.contrib.browserView.autoReload', WorkbenchPhase.BlockRestore, services => {
	services.get(IBrowserAutoReloadService);
	return Disposable.None;
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: settingId,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('Invalid browser auto reload setting');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.workbench', key: 'browser.autoReloadDefault' }, 'Reload local browser files on change'),
		description: localize(
			{ bundle: 'ash.workbench', key: 'browser.autoReloadDefaultDescription' },
			'Automatically reload local file pages when their files change. Local HTTP previews can opt in from Page actions.',
		),
	},
});
