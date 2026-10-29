import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	IContentSearchConfigurationService,
	type ContentSearchConfiguration,
	type ContentSearchEngine,
} from '../../../../platform/search/common/search.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../preferences/browser/settingsTreeModels.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ContentSearchSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Content search accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize({ bundle: 'ash.settings', key: 'search.verbosity' }, 'Content search accessibility help');
		},
		get description() {
			return localize(
				{ bundle: 'ash.settings', key: 'search.verbosityDescription' },
				'Announce how to open accessibility help in content search settings.',
			);
		},
	},
});

type Status = 'loading' | 'ready' | 'saving' | 'saved' | 'readFailed' | 'saveFailed' | 'disconnected';

/** Reads and edits the backend revision; Preferences owns every control displaying it. */
export class SearchSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'search';
	public readonly groupId = 'general.content-search';
	public readonly itemId = 'grep.backend';
	public readonly keywords = ['tgrep', 'ripgrep', 'rg', 'grep', 'backend', 'content search'];
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private snapshot: ContentSearchConfiguration | undefined;
	private state: Status = 'loading';
	private visible = false;
	private busy = false;
	// A new connection invalidates reads and saves belonging to the old backend.
	private version = 0;

	constructor(
		@IContentSearchConfigurationService private readonly search: IContentSearchConfigurationService,
		@IAppServerRemoteAgentService remote: IAppServerRemoteAgentService,
	) {
		super();
		this._register(
			remote.onDidChangeConnectionState(state => {
				if (state !== 'connected') this.invalidate();
				else if (this.visible && !this.snapshot) void this.refresh();
			}),
		);
		this._register(
			remote.onDidChangeConnection(() => {
				this.invalidate();
				if (this.visible) void this.refresh();
			}),
		);
	}

	public get groupTitle(): string {
		return localize({ bundle: 'ash.settings', key: 'search.group' }, 'Content search');
	}

	public get title(): string {
		return localize({ bundle: 'ash.settings', key: 'search.engine' }, 'Indexed search engine');
	}

	public get description(): string {
		return localize(
			{ bundle: 'ash.settings', key: 'search.description' },
			'tgrep accelerates Agent and Codebase indexed searches. Choosing ripgrep disables indexes and scans current files. Editor Current searches always use ripgrep (rg). This preference also controls indexed file name searches.',
		);
	}

	public get help(): string {
		return localize(
			{ bundle: 'ash.settings', key: 'search.help' },
			'Content search settings\nUse Tab to reach Indexed search engine and Refresh. Open Indexed search engine with Enter or Space, use the arrow keys to choose tgrep or ripgrep, and press Enter to save. tgrep is the default for Agent and Codebase indexed searches. Choosing ripgrep disables indexes and scans current files. Editor Current searches always use ripgrep. This preference also controls indexed file name searches. Refresh reads the backend configuration. If saving fails, refresh before trying again. Press Escape to close help and return to the control.',
		);
	}

	public get fields(): readonly SettingsSectionField[] {
		return [
			{
				id: 'engine',
				kind: 'select',
				label: localize({ bundle: 'ash.settings', key: 'search.engine' }, 'Indexed search engine'),
				value: this.snapshot?.engine,
				enabled: !!this.snapshot && !this.busy,
				options: [
					{
						value: 'tgrep',
						label: localize({ bundle: 'ash.settings', key: 'search.default' }, 'tgrep (default)'),
					},
					{ value: 'ripgrep', label: 'ripgrep' },
				],
				setValue: value => {
					void this.configure(value as ContentSearchEngine);
				},
			},
			{ id: 'status', kind: 'status', text: this.status },
			{
				id: 'refresh',
				kind: 'action',
				enabled: !this.busy,
				label: localize({ bundle: 'ash.settings', key: 'search.refresh' }, 'Refresh'),
				run: () => this.refresh(),
			},
		];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (!visible) {
			this.version++;
			this.busy = false;
		} else {
			void this.refresh();
		}
	}

	private invalidate(): void {
		this.version++;
		this.snapshot = undefined;
		this.busy = false;
		this.state = 'disconnected';
		this.changed.fire();
	}

	private async refresh(): Promise<void> {
		if (this.busy) {
			return;
		}
		const version = ++this.version;
		this.busy = true;
		this.state = 'loading';
		this.changed.fire();
		try {
			const snapshot = await this.search.read();
			if (this.isDisposed || version !== this.version) {
				return;
			}
			this.snapshot = snapshot;
			this.state = 'ready';
		} catch {
			if (this.isDisposed || version !== this.version) {
				return;
			}
			this.snapshot = undefined;
			this.state = 'readFailed';
		} finally {
			if (!this.isDisposed && version === this.version) {
				this.busy = false;
				this.changed.fire();
			}
		}
	}

	private async configure(engine: ContentSearchEngine): Promise<void> {
		if (!this.visible || !this.snapshot || this.busy || this.snapshot.engine === engine) {
			return;
		}
		const version = ++this.version;
		this.busy = true;
		this.state = 'saving';
		this.changed.fire();
		try {
			await this.search.configure(engine, this.snapshot.revision);
			if (this.isDisposed || version !== this.version) {
				return;
			}
			const snapshot = await this.search.read();
			if (this.isDisposed || version !== this.version) {
				return;
			}
			this.snapshot = snapshot;
			this.state = 'saved';
		} catch {
			if (this.isDisposed || version !== this.version) {
				return;
			}
			this.snapshot = undefined;
			this.state = 'saveFailed';
		} finally {
			if (!this.isDisposed && version === this.version) {
				this.busy = false;
				this.changed.fire();
			}
		}
	}

	private get status(): string {
		switch (this.state) {
			case 'ready':
				return '';
			case 'loading':
				return localize({ bundle: 'ash.settings', key: 'search.loading' }, 'Reading search configuration…');
			case 'saving':
				return localize({ bundle: 'ash.settings', key: 'search.saving' }, 'Saving search engine…');
			case 'saved':
				return localize({ bundle: 'ash.settings', key: 'search.saved' }, 'Search engine saved.');
			case 'readFailed':
				return localize(
					{ bundle: 'ash.settings', key: 'search.readFailed' },
					'Could not read search configuration. Connect to App Server and refresh.',
				);
			case 'saveFailed':
				return localize(
					{ bundle: 'ash.settings', key: 'search.saveFailed' },
					'Could not save search engine. Refresh the configuration before trying again.',
				);
			case 'disconnected':
				return localize({ bundle: 'ash.settings', key: 'search.disconnected' }, 'App Server is disconnected.');
		}
	}
}
