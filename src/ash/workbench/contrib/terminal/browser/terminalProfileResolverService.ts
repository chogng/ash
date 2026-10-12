import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITerminalProcessService, type IShellLaunchConfig, type ITerminalProfile, type ITerminalProfileObject, type TerminalArguments } from '../../../../platform/terminal/common/terminal.js';
import { mergeEnvironments } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { ITerminalProfileResolverService, ITerminalProfileService, type IShellLaunchConfigResolveOptions } from '../../../services/terminal/common/terminal.js';

/** Resolves caller-owned launch data against one initialized execution host and workspace generation. */
export class BrowserTerminalProfileResolverService extends Disposable implements ITerminalProfileResolverService {
	private generation = 0;

	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IConfigurationResolverService private readonly variables: IConfigurationResolverService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.generation++));
		this._register(processes.onConnectionState(() => this.generation++));
	}

	get defaultProfileName(): string | undefined { return this.profiles.getDefaultProfileName(); }
	getDefaultIcon(): ThemeIcon { return ThemeIcon.fromId('terminal'); }

	resolveIcon(shellLaunchConfig: IShellLaunchConfig, os: OperatingSystem): void {
		shellLaunchConfig.icon ??= shellLaunchConfig.executable ? this.getDefaultIcon() : this.profiles.getDefaultProfile(os)?.icon ?? this.getDefaultIcon();
	}

	async getEnvironment(remoteAuthority: string | undefined): Promise<Readonly<Record<string, string>>> {
		this.assertAuthority(remoteAuthority);
		const generation = this.generation;
		const environment = await this.processes.getEnvironment(undefined, this.sessionFolderId());
		this.assertCurrent(generation);
		return environment;
	}

	async getDefaultProfile(options: IShellLaunchConfigResolveOptions): Promise<ITerminalProfile> {
		this.assertOptions(options);
		const generation = this.generation;
		await this.profiles.profilesReady;
		this.assertCurrent(generation);
		const platform = await this.profiles.getPlatformKey();
		let profile = this.profiles.getDefaultProfile(options.os);
		const kind = options.allowAgentHostShell ? 'agentHostProfile' : options.allowAutomationShell ? 'automationProfile' : undefined;
		const configured = kind ? this.configuration.getValue<ITerminalProfileObject | null>(`${TERMINAL_CONFIG_SECTION}.${kind}.${platform}`) : undefined;
		if (configured?.path) {
			const name = kind === 'agentHostProfile' ? localize('terminal.profile.agentHostShell', 'Agent host shell') : localize('terminal.profile.automationShell', 'Automation shell');
			profile = {
				profileId: `custom:${kind}`, profileName: name, title: name, isDefault: false,
				path: configured.path, args: configured.args, env: configured.env,
				icon: configured.icon ? ThemeIcon.fromId(configured.icon) : undefined, color: configured.color,
			};
		}
		if (!profile) {
			const resolved = await this.processes.resolveProfile({ type: 'default' }, this.sessionFolderId());
			this.assertCurrent(generation);
			return { ...resolved.profile, profileName: resolved.profile.title, path: resolved.executable, args: resolved.args };
		}
		const environment = await this.getEnvironment(options.remoteAuthority);
		const resolved = await this.resolveProfile(profile, environment);
		this.assertCurrent(generation);
		return resolved;
	}

	async getDefaultShell(options: IShellLaunchConfigResolveOptions): Promise<string> {
		const profile = await this.getDefaultProfile(options);
		return typeof profile.path === 'string' ? profile.path : profile.path[0]!;
	}

	async getDefaultShellArgs(options: IShellLaunchConfigResolveOptions): Promise<TerminalArguments> {
		return (await this.getDefaultProfile(options)).args ?? [];
	}

	async resolveShellLaunchConfig(shell: IShellLaunchConfig, options: IShellLaunchConfigResolveOptions): Promise<void> {
		this.assertOptions(options);
		if (shell.customPtyImplementation) { this.resolveIcon(shell, options.os); return; }
		if (typeof shell.args === 'string' && options.os !== OperatingSystem.Windows) throw new Error(localize('terminal.profile.windowsCommandLine', 'Raw command line strings are only supported on Windows.'));
		const generation = this.generation;
		const platform = await this.profiles.getPlatformKey();
		const overrides: Record<string, string | null> = {};
		mergeEnvironments(overrides, this.configuration.getValue<Readonly<Record<string, string | null>>>(`${TERMINAL_CONFIG_SECTION}.env.${platform}`), options.os !== OperatingSystem.Windows);
		const environment = await this.getEnvironment(options.remoteAuthority);
		const profile = shell.executable
			? await this.resolveProfile({ profileId: 'custom', profileName: shell.name ?? localize('terminal.profile.shell', 'Shell'), title: shell.name ?? localize('terminal.profile.shell', 'Shell'), isDefault: false, path: shell.executable, args: shell.args, env: shell.env, icon: shell.icon, color: shell.color }, environment)
			: await this.getDefaultProfile(options);
		mergeEnvironments(overrides, profile.env, options.os !== OperatingSystem.Windows);
		mergeEnvironments(overrides, shell.env, options.os !== OperatingSystem.Windows);
		const folder = this.workspace.getWorkspace().folders[0];
		const resolve = (value: string) => this.variables.resolveWithEnvironment(environment, folder, value);
		const env = Object.fromEntries(await Promise.all(Object.entries(overrides).map(async ([key, value]) => [key, value === null ? null : await resolve(value)])));
		const cwd = shell.cwd ?? this.configuration.getValue<string>(`${TERMINAL_CONFIG_SECTION}.cwd`);
		const resolvedCwd = cwd ? await resolve(cwd) : undefined;
		const resolvedArgs = shell.args === undefined ? profile.args ?? [] : typeof shell.args === 'string' ? await resolve(shell.args) : await Promise.all(shell.args.map(resolve));
		const executable = typeof profile.path === 'string' ? profile.path : profile.path[0]!;
		this.assertCurrent(generation);
		shell.executable = executable;
		shell.args = resolvedArgs;
		shell.env = Object.freeze(env);
		shell.cwd = resolvedCwd;
		shell.icon ??= profile.icon ?? this.getDefaultIcon();
		shell.color ??= profile.color;
		if (profile.overrideName && shell.name === undefined) shell.name = profile.profileName;
	}

	private async resolveProfile(profile: ITerminalProfile, environment: Readonly<Record<string, string>>): Promise<ITerminalProfile> {
		const folder = this.workspace.getWorkspace().folders[0];
		const resolve = (value: string) => this.variables.resolveWithEnvironment(environment, folder, value);
		const path = await Promise.all((typeof profile.path === 'string' ? [profile.path] : profile.path).map(value => resolve(value.replace(/^~(?=$|[/\\])/, '${userHome}'))));
		if (typeof profile.args === 'string' && this.processes.operatingSystem !== OperatingSystem.Windows) {
			throw new Error(localize('terminal.profile.windowsCommandLine', 'Raw command line strings are only supported on Windows.'));
		}
		const args = typeof profile.args === 'string' ? await resolve(profile.args) : await Promise.all((profile.args ?? []).map(resolve));
		const result = await this.processes.resolveProfile({ type: 'custom', name: profile.profileName, path, args });
		return { ...profile, path: result.executable, args: result.args };
	}

	private sessionFolderId(): string | undefined {
		const folders = this.workspace.getWorkspace().folders;
		return folders.length === 1 && folders[0]!.id.startsWith('session:') ? folders[0]!.id : undefined;
	}

	private assertAuthority(remoteAuthority: string | undefined): void {
		if (this.isDisposed) throw new CancellationError();
		const authority = this.workspace.getWorkspace().folders[0]?.uri.authority || undefined;
		if (remoteAuthority !== undefined && remoteAuthority !== authority) throw new Error(localize('terminal.profile.targetMismatch', 'The requested terminal execution host is not selected.'));
	}

	private assertOptions(options: IShellLaunchConfigResolveOptions): void {
		this.assertAuthority(options.remoteAuthority);
		if (this.processes.operatingSystem !== options.os) throw new Error(localize('terminal.profile.targetMismatch', 'The requested terminal execution host is not selected.'));
	}

	private assertCurrent(generation: number): void {
		if (this.isDisposed || generation !== this.generation) throw new CancellationError();
	}
}
