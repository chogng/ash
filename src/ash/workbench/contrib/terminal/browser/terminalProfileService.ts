import '../common/terminalConfiguration.js';
import { CancellationError, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITerminalProcessService, type ITerminalProcessProfile } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalProfileService, TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { ITerminalService } from './terminal.js';

/** Owns the window's discovered shell list; executable definitions remain on the execution host. */
export class TerminalProfileService extends Disposable implements ITerminalProfileService {
	private profiles: readonly ITerminalProcessProfile[] = [];
	private revision = 0;
	private request: Promise<void> | undefined;
	private activated = false;
	private readonly changed = this._register(new Emitter<readonly ITerminalProcessProfile[]>());
	readonly onDidChangeAvailableProfiles = this.changed.event;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`${TERMINAL_CONFIG_SECTION}.defaultProfile`)) this.changed.fire(this.availableProfiles);
		}));
		this._register(processes.onConnectionState(state => {
			this.invalidate();
			if (state === 'ready' && this.activated && workspace.getWorkspace().folders.length) this.refreshInBackground();
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.invalidate();
			if (this.activated && workspace.getWorkspace().folders.length) this.refreshInBackground();
		}));
	}

	get availableProfiles(): readonly ITerminalProcessProfile[] {
		const defaultProfile = this.getDefaultProfile();
		return this.profiles.map(profile => Object.freeze({ ...profile, isDefault: profile === defaultProfile }));
	}

	getDefaultProfileName(): string | undefined {
		const platform = platformKey(this.processes.operatingSystem);
		return platform ? this.configuration.getValue<string | null>(`${TERMINAL_CONFIG_SECTION}.defaultProfile.${platform}`) ?? undefined : undefined;
	}

	getDefaultProfile(): ITerminalProcessProfile | undefined {
		const name = this.getDefaultProfileName();
		return this.profiles.find(profile => profile.title === name) ?? this.profiles.find(profile => profile.isDefault);
	}

	async getPlatformKey(): Promise<'linux' | 'osx' | 'windows'> {
		const platform = platformKey(this.processes.operatingSystem);
		if (!platform) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
		return platform;
	}

	refreshAvailableProfiles(): Promise<void> {
		if (this.isDisposed) return Promise.reject(new CancellationError());
		this.activated = true;
		if (this.request) return this.request;
		const revision = this.revision;
		const request = this.terminals.getProfiles().then(profiles => {
			if (this.isDisposed || revision !== this.revision) throw new CancellationError();
			this.profiles = Object.freeze(profiles.map(profile => Object.freeze({ ...profile })));
			this.changed.fire(this.availableProfiles);
		}).finally(() => { if (this.request === request) this.request = undefined; });
		this.request = request;
		return request;
	}

	private refreshInBackground(): void {
		void this.refreshAvailableProfiles().catch(error => { if (!isCancellationError(error)) onUnexpectedError(error); });
	}

	private invalidate(): void {
		this.revision++;
		this.request = undefined;
		this.profiles = [];
		this.changed.fire([]);
	}

	protected override disposeCore(): void {
		this.revision++;
		this.profiles = [];
		this.request = undefined;
		super.disposeCore();
	}
}

function platformKey(os: OperatingSystem | undefined): 'linux' | 'osx' | 'windows' | undefined {
	switch (os) {
		case OperatingSystem.Linux: return 'linux';
		case OperatingSystem.Macintosh: return 'osx';
		case OperatingSystem.Windows: return 'windows';
		default: return undefined;
	}
}
