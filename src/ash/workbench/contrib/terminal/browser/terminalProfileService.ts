import '../common/terminalConfiguration.js';
import { CancellationError, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITerminalProcessService, type ITerminalProfile, type ITerminalProfileObject, type IExtensionTerminalProfile, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { ITerminalProfileService, TERMINAL_CONFIG_SECTION, type IRegisterContributedProfileArgs, type ITerminalProfileProvider } from '../common/terminal.js';
import { ITerminalService } from './terminal.js';

type ProfileDefinition = ITerminalProfileObject | (IExtensionTerminalProfile & Pick<ITerminalProfileObject, 'icon' | 'color'>) | null;

/** Owns catalog and provider lifetimes; executable resolution and PTYs stay on the execution host. */
export class TerminalProfileService extends Disposable implements ITerminalProfileService {
	private profiles: readonly ITerminalProfile[] = [];
	private revision = 0;
	private request: Promise<void> | undefined;
	private activated = false;
	private readonly internalProfiles = new Map<string, IExtensionTerminalProfile>();
	private readonly providers = new Map<string, ITerminalProfileProvider>();
	private readonly defaultOverrides: { extensionIdentifier: string; id: string; }[] = [];
	private readonly changed = this._register(new Emitter<readonly ITerminalProfile[]>());
	readonly onDidChangeAvailableProfiles = this.changed.event;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IExtensionService private readonly extensions: IExtensionService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(TERMINAL_CONFIG_SECTION)) this.changed.fire(this.availableProfiles);
		}));
		this._register(extensions.onDidChange(() => this.changed.fire(this.availableProfiles)));
		this._register(processes.onConnectionState(state => {
			this.invalidate();
			if (state === 'ready' && this.activated && workspace.getWorkspace().folders.length) this.refreshInBackground();
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.invalidate();
			if (this.activated && workspace.getWorkspace().folders.length) this.refreshInBackground();
		}));
	}

	get profilesReady(): Promise<void> { return this.refreshAvailableProfiles(); }

	get availableProfiles(): readonly ITerminalProfile[] {
		const profiles = this.profileEntries(this.processes.operatingSystem);
		const selected = this.selectDefault(profiles, this.processes.operatingSystem);
		return profiles.map(profile => Object.freeze({ ...profile, isDefault: profile.profileId === selected?.profileId }));
	}

	get contributedProfiles(): readonly IExtensionTerminalProfile[] {
		const profiles = new Map(this.extensions.terminalProfiles.map(profile => [profileKey(profile.extensionIdentifier, profile.id), profile]));
		for (const [key, profile] of this.internalProfiles) profiles.set(key, { ...profiles.get(key), ...profile });
		return [...profiles.values()];
	}

	getDefaultProfileName(): string | undefined {
		const platform = platformKey(this.processes.operatingSystem);
		return platform ? this.configuration.getValue<string | null>(`${TERMINAL_CONFIG_SECTION}.defaultProfile.${platform}`) ?? undefined : undefined;
	}

	getDefaultProfile(os = this.processes.operatingSystem): ITerminalProfile | undefined {
		return this.selectDefault(this.profileEntries(os), os);
	}

	private selectDefault(profiles: readonly ITerminalProfile[], os: OperatingSystem | undefined): ITerminalProfile | undefined {
		const platform = platformKey(os);
		const name = platform ? this.configuration.getValue<string | null>(`${TERMINAL_CONFIG_SECTION}.defaultProfile.${platform}`) : undefined;
		return profiles.find(profile => profile.profileName === name) ?? profiles.find(profile => profile.isDefault);
	}

	private profileEntries(os: OperatingSystem | undefined): ITerminalProfile[] {
		const platform = platformKey(os);
		const definitions = platform ? this.configuration.getValue<Readonly<Record<string, ProfileDefinition>>>(`${TERMINAL_CONFIG_SECTION}.profiles.${platform}`) : {};
		const profiles = new Map(this.profiles.filter(profile => definitions[profile.profileName] !== null).map(profile => [profile.profileName, profile]));
		for (const [name, definition] of Object.entries(definitions)) {
			if (!definition || 'extensionIdentifier' in definition) continue;
			const source = definition.source ? this.profiles.find(profile => profile.profileId === (definition.source === 'PowerShell' ? 'powershell' : 'git-bash') || profile.profileName === definition.source)
				?? (definition.source === 'PowerShell' ? this.profiles.find(profile => profile.profileId === 'windows-powershell') : undefined) : undefined;
			const path = definition.path ?? source?.path;
			if (!path) continue;
			profiles.set(name, Object.freeze({
				profileId: `custom:${name}`, title: name, profileName: name, path,
				args: definition.args ?? source?.args, env: definition.env, overrideName: definition.overrideName,
				icon: definition.icon ? ThemeIcon.fromId(definition.icon) : source?.icon, color: definition.color ?? source?.color, isDefault: source?.isDefault ?? false,
			}));
		}
		return [...profiles.values()];
	}

	async getPlatformKey(): Promise<'linux' | 'osx' | 'windows'> {
		if (this.isDisposed) throw new CancellationError();
		const platform = platformKey(this.processes.operatingSystem);
		if (!platform) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
		return platform;
	}

	refreshAvailableProfiles(): Promise<void> {
		if (this.isDisposed) return Promise.reject(new CancellationError());
		this.activated = true;
		if (this.request) return this.request;
		const revision = this.revision;
		const request = this.terminals.getProfiles().then(async profiles => {
			const resolved = await Promise.all(profiles.map(async profile => {
				const result = await this.processes.resolveProfile({ type: 'profile', profileId: profile.profileId });
				return Object.freeze({ ...profile, profileName: profile.title, path: result.executable, args: Object.freeze([...result.args]), isAutoDetected: true });
			}));
			if (this.isDisposed || revision !== this.revision) throw new CancellationError();
			this.profiles = Object.freeze(resolved);
			this.changed.fire(this.availableProfiles);
		}).finally(() => { if (this.request === request) this.request = undefined; });
		this.request = request;
		return request;
	}

	async getContributedDefaultProfile(shellLaunchConfig: IShellLaunchConfig): Promise<IExtensionTerminalProfile | undefined> {
		if (shellLaunchConfig.executable || shellLaunchConfig.customPtyImplementation) return undefined;
		const override = this.defaultOverrides.at(-1);
		if (override) return this.contributedProfiles.find(profile => profileKey(profile.extensionIdentifier, profile.id) === profileKey(override.extensionIdentifier, override.id));
		const name = this.getDefaultProfileName();
		if (!name) return undefined;
		const platform = await this.getPlatformKey();
		const definitions = this.configuration.getValue<Readonly<Record<string, ProfileDefinition>>>(`${TERMINAL_CONFIG_SECTION}.profiles.${platform}`);
		const definition = definitions[name];
		if (definition && 'extensionIdentifier' in definition) {
			const profile = this.contributedProfiles.find(profile => profileKey(profile.extensionIdentifier, profile.id) === profileKey(definition.extensionIdentifier, definition.id));
			return profile && { ...profile, options: { ...profile.options, ...(definition.icon ? { icon: ThemeIcon.fromId(definition.icon) } : {}), ...(definition.color ? { color: definition.color } : {}) } };
		}
		return this.contributedProfiles.find(profile => profile.title === name);
	}

	async registerContributedProfile(args: IRegisterContributedProfileArgs): Promise<void> {
		const platform = await this.getPlatformKey();
		const key = `${TERMINAL_CONFIG_SECTION}.profiles.${platform}`;
		const profiles = this.configuration.getValue<Readonly<Record<string, ProfileDefinition>>>(key);
		await this.configuration.updateValue(key, {
			...profiles, [args.title]: {
				extensionIdentifier: args.extensionIdentifier, id: args.id, title: args.title,
				...(args.options?.icon ? { icon: args.options.icon.id } : {}), ...(args.options?.color ? { color: args.options.color } : {}),
			}
		}, ConfigurationTarget.USER);
	}

	registerInternalContributedProfile(profile: IExtensionTerminalProfile): IDisposable {
		if (this.isDisposed) throw new CancellationError();
		const key = profileKey(profile.extensionIdentifier, profile.id);
		if (this.internalProfiles.has(key)) throw new Error(localize('terminal.profile.duplicate', 'Terminal profile is already registered: {0}', key));
		this.internalProfiles.set(key, profile); this.changed.fire(this.availableProfiles);
		return toDisposable(() => { if (this.internalProfiles.get(key) === profile) { this.internalProfiles.delete(key); if (!this.isDisposed) this.changed.fire(this.availableProfiles); } });
	}

	getContributedProfileProvider(extensionIdentifier: string, id: string): ITerminalProfileProvider | undefined {
		const key = profileKey(extensionIdentifier, id);
		if (!this.providers.has(key) && !this.contributedProfiles.some(profile => profileKey(profile.extensionIdentifier, profile.id) === key)) return undefined;
		return {
			createContributedTerminalProfile: async options => {
				if (this.isDisposed) throw new CancellationError();
				if (!this.providers.has(key)) await this.extensions.activateByEvent(`onTerminalProfile:${id}`);
				if (this.isDisposed) throw new CancellationError();
				const provider = this.providers.get(key);
				if (!provider) throw new Error(localize('terminal.profile.providerUnavailable', 'Terminal profile provider is unavailable: {0}', key));
				await provider.createContributedTerminalProfile(options);
				if (this.isDisposed || this.providers.get(key) !== provider) throw new CancellationError();
			}
		};
	}

	registerTerminalProfileProvider(extensionIdentifier: string, id: string, provider: ITerminalProfileProvider): IDisposable {
		if (this.isDisposed) throw new CancellationError();
		const key = profileKey(extensionIdentifier, id);
		if (this.providers.has(key)) throw new Error(localize('terminal.profile.duplicate', 'Terminal profile is already registered: {0}', key));
		this.providers.set(key, provider);
		return toDisposable(() => { if (this.providers.get(key) === provider) this.providers.delete(key); });
	}

	overrideDefaultProfile(extensionIdentifier: string, id: string): IDisposable {
		if (this.isDisposed) throw new CancellationError();
		const override = { extensionIdentifier, id };
		this.defaultOverrides.push(override);
		return toDisposable(() => { const index = this.defaultOverrides.indexOf(override); if (index !== -1) this.defaultOverrides.splice(index, 1); });
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
		this.revision++; this.profiles = []; this.request = undefined;
		this.providers.clear(); this.internalProfiles.clear(); this.defaultOverrides.length = 0;
		super.disposeCore();
	}
}

function profileKey(extensionIdentifier: string, id: string): string { return `${extensionIdentifier}/${id}`; }

function platformKey(os: OperatingSystem | undefined): 'linux' | 'osx' | 'windows' | undefined {
	switch (os) {
		case OperatingSystem.Linux: return 'linux';
		case OperatingSystem.Macintosh: return 'osx';
		case OperatingSystem.Windows: return 'windows';
		default: return undefined;
	}
}
