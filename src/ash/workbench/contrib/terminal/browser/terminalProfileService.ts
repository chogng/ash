import '../common/terminalConfiguration.js';
import { CancellationError, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITerminalProcessService, TerminalSettingPrefix, type ITerminalProfile, type ITerminalProfileObject, type IExtensionTerminalProfile, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { ITerminalContributionService, ITerminalProfileService, type IRegisterContributedProfileArgs, type ITerminalProfileProvider } from '../common/terminal.js';
import { registerTerminalDefaultProfileConfiguration } from '../../../../platform/terminal/common/terminalPlatformConfiguration.js';
import { terminalIconsEqual, terminalProfileArgsMatch } from '../../../../platform/terminal/common/terminalProfiles.js';

type ProfileDefinition = ITerminalProfileObject | (IExtensionTerminalProfile & Pick<ITerminalProfileObject, 'icon' | 'color'>) | null;

/** Owns catalog and provider lifetimes; executable resolution and PTYs stay on the execution host. */
export class TerminalProfileService extends Disposable implements ITerminalProfileService {
	private readonly catalogs = new Map<string | undefined, readonly ITerminalProfile[]>();
	private revision = 0;
	private readonly requests = new Map<string | undefined, Promise<void>>();
	private selectedDirId: string | undefined;
	private activated = false;
	private readonly internalProfiles = new Map<string, IExtensionTerminalProfile>();
	private readonly providers = new Map<string, ITerminalProfileProvider>();
	private readonly defaultOverrides: { extensionIdentifier: string; id: string; }[] = [];
	private readonly changed = this._register(new Emitter<readonly ITerminalProfile[]>());
	readonly onDidChangeAvailableProfiles = this.changed.event;

	constructor(
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ITerminalContributionService private readonly contributions: ITerminalContributionService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(TERMINAL_CONFIG_SECTION)) {
				// Schema updates are shared across service scopes. Reflect their defaults
				// without publishing this scope's suggestions back into the same update.
				this.fireProfilesChanged(event.source !== ConfigurationTarget.DEFAULT);
			}
		}));
		this._register(contributions.onDidChangeTerminalProfiles(() => this.fireProfilesChanged()));
		this._register(processes.onConnectionState(state => {
			this.invalidate();
			if (state === 'ready' && this.activated) this.refreshInBackground();
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			if (!workspace.getWorkspace().folders.some(folder => folder.id === this.selectedDirId)) this.selectedDirId = undefined;
			this.invalidate();
			if (this.activated) this.refreshInBackground();
		}));
		const os = this.processes.operatingSystem;
		if (os) registerTerminalDefaultProfileConfiguration({ os, profiles: this.availableProfiles }, this.contributedProfiles);
	}

	get profilesReady(): Promise<void> { return this.refreshAvailableProfiles(); }

	private fireProfilesChanged(updateSchema = true): void {
		const profiles = this.availableProfiles;
		const os = this.processes.operatingSystem;
		if (updateSchema && os) registerTerminalDefaultProfileConfiguration({ os, profiles }, this.contributedProfiles);
		this.changed.fire(profiles);
	}

	get availableProfiles(): readonly ITerminalProfile[] {
		return this.getAvailableProfiles();
	}

	getAvailableProfiles(dirId = this.selectedDirId): readonly ITerminalProfile[] {
		const profiles = this.profileEntries(this.processes.operatingSystem, dirId);
		const selected = this.selectDefault(profiles, this.processes.operatingSystem);
		return profiles.map(profile => Object.freeze({ ...profile, isDefault: profile.profileId === selected?.profileId }));
	}

	get contributedProfiles(): readonly IExtensionTerminalProfile[] {
		const profiles = new Map(this.contributions.terminalProfiles.map(profile => [profileKey(profile.extensionIdentifier, profile.id), profile]));
		for (const [key, profile] of this.internalProfiles) profiles.set(key, { ...profiles.get(key), ...profile });
		return [...profiles.values()];
	}

	getDefaultProfileName(): string | undefined {
		const platform = platformKey(this.processes.operatingSystem);
		return platform ? this.configuration.getValue<string | null>(`${TerminalSettingPrefix.DefaultProfile}${platform}`) ?? undefined : undefined;
	}

	getDefaultProfile(os = this.processes.operatingSystem, dirId = this.selectedDirId): ITerminalProfile | undefined {
		return this.selectDefault(this.profileEntries(os, dirId), os);
	}

	private selectDefault(profiles: readonly ITerminalProfile[], os: OperatingSystem | undefined): ITerminalProfile | undefined {
		const platform = platformKey(os);
		const name = platform ? this.configuration.getValue<string | null>(`${TerminalSettingPrefix.DefaultProfile}${platform}`) : undefined;
		return profiles.find(profile => profile.profileName === name) ?? profiles.find(profile => profile.isDefault);
	}

	private profileEntries(os: OperatingSystem | undefined, dirId: string | undefined): ITerminalProfile[] {
		const folders = this.workspace.getWorkspace().folders;
		const scope = dirId || (folders.length === 1 ? folders[0]!.id : undefined);
		const detected = this.catalogs.get(scope) ?? [];
		const platform = platformKey(os);
		const definitions = platform ? this.configuration.getValue<Readonly<Record<string, ProfileDefinition>>>(`${TerminalSettingPrefix.Profiles}${platform}`) : {};
		const profiles = new Map(detected.filter(profile => definitions[profile.profileName] !== null).map(profile => [profile.profileName, profile]));
		for (const [name, definition] of Object.entries(definitions)) {
			if (!definition || 'extensionIdentifier' in definition) continue;
			const source = definition.source ? detected.find(profile => profile.profileId === (definition.source === 'PowerShell' ? 'powershell' : 'git-bash') || profile.profileName === definition.source)
				?? (definition.source === 'PowerShell' ? detected.find(profile => profile.profileId === 'windows-powershell') : undefined) : undefined;
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

	refreshAvailableProfiles(selectedDirId = this.selectedDirId): Promise<void> {
		if (this.isDisposed) return Promise.reject(new CancellationError());
		// Instances without a workspace folder use an empty presentation identity;
		// execution-host requests and the host profile catalog use no directory ID.
		selectedDirId = selectedDirId || undefined;
		this.activated = true;
		if (selectedDirId !== this.selectedDirId) {
			this.selectedDirId = selectedDirId;
			this.fireProfilesChanged();
		}
		const folders = this.workspace.getWorkspace().folders;
		const dirId = selectedDirId ?? (folders.length === 1 ? folders[0]!.id : undefined);
		const existing = this.requests.get(dirId);
		if (existing) return existing;
		const revision = this.revision;

		const request = this.processes.listProfiles(dirId).then(async profiles => {
			const resolved = await Promise.all(profiles.map(async profile => {
				const result = await this.processes.resolveProfile({ type: 'profile', profileId: profile.profileId }, dirId);
				return Object.freeze({ ...profile, icon: undefined, profileName: profile.title, path: result.executable, args: (typeof result.args === 'string' ? result.args : Object.freeze([...result.args])), isAutoDetected: true });
			}));
			if (this.isDisposed || revision !== this.revision) throw new CancellationError();
			const previous = this.catalogs.get(dirId) ?? [];
			const changed = resolved.length !== previous.length || resolved.some((profile, index) => {
				const old = previous[index];
				return !old || profile.profileId !== old.profileId || profile.title !== old.title || profile.path !== old.path || profile.isDefault !== old.isDefault
					|| !terminalProfileArgsMatch(profile.args, old.args) || !terminalIconsEqual(profile.icon, old.icon);
			});
			this.catalogs.set(dirId, Object.freeze(resolved));
			if (changed && (this.selectedDirId === dirId || !this.selectedDirId && folders.length === 1)) this.fireProfilesChanged();
		}).finally(() => { if (this.requests.get(dirId) === request) this.requests.delete(dirId); });
		this.requests.set(dirId, request);
		return request;
	}

	async getContributedDefaultProfile(shellLaunchConfig: IShellLaunchConfig): Promise<IExtensionTerminalProfile | undefined> {
		if (shellLaunchConfig.executable || shellLaunchConfig.customPtyImplementation) return undefined;
		const override = this.defaultOverrides.at(-1);
		if (override) return this.contributedProfiles.find(profile => profileKey(profile.extensionIdentifier, profile.id) === profileKey(override.extensionIdentifier, override.id));
		const name = this.getDefaultProfileName();
		if (!name) return undefined;
		const platform = await this.getPlatformKey();
		const definitions = this.configuration.getValue<Readonly<Record<string, ProfileDefinition>>>(`${TerminalSettingPrefix.Profiles}${platform}`);
		const definition = definitions[name];
		if (definition && 'extensionIdentifier' in definition) {
			const profile = this.contributedProfiles.find(profile => profileKey(profile.extensionIdentifier, profile.id) === profileKey(definition.extensionIdentifier, definition.id));
			return profile && { ...profile, options: { ...profile.options, ...(definition.icon ? { icon: ThemeIcon.fromId(definition.icon) } : {}), ...(definition.color ? { color: definition.color } : {}) } };
		}
		return this.contributedProfiles.find(profile => profile.title === name);
	}

	async registerContributedProfile(args: IRegisterContributedProfileArgs): Promise<void> {
		const platform = await this.getPlatformKey();
		const key = `${TerminalSettingPrefix.Profiles}${platform}`;
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
		this.internalProfiles.set(key, profile); this.fireProfilesChanged();
		return toDisposable(() => { if (this.internalProfiles.get(key) === profile) { this.internalProfiles.delete(key); if (!this.isDisposed) this.fireProfilesChanged(); } });
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
				// The provider owns cancellation and cleanup once creation begins. Preserve
				// its result so the caller can place or release that exact instance.
				return provider.createContributedTerminalProfile(options);
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
		if (!this.selectedDirId && this.workspace.getWorkspace().folders.length > 1) return;
		void this.refreshAvailableProfiles().catch(error => { if (!isCancellationError(error)) onUnexpectedError(error); });
	}

	private invalidate(): void {
		this.revision++;
		this.requests.clear();
		this.catalogs.clear();
		this.fireProfilesChanged();
	}

	protected override disposeCore(): void {
		this.revision++; this.catalogs.clear(); this.requests.clear();
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
