import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { OperatingSystem, type IProcessEnvironment } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITerminalProcessService, TerminalSettingId, TerminalSettingPrefix, type IShellLaunchConfig, type ITerminalProfile, type ITerminalProfileObject, type TerminalArguments } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';
import { MergedEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariableCollection.js';
import { serializeEnvironmentVariableCollections } from '../../../../platform/terminal/common/environmentVariableShared.js';
import { sanitizeCwd, shouldUseEnvironmentVariableCollection } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { createTerminalEnvironment, mergeEnvironments } from '../common/terminalEnvironment.js';
import { ITerminalProfileResolverService, ITerminalProfileService, type IShellLaunchConfigResolveOptions } from '../common/terminal.js';

/** Resolves caller-owned launch data against one initialized execution host and workspace generation. */
export abstract class BaseTerminalProfileResolverService extends Disposable implements ITerminalProfileResolverService {
	private generation = 0;

	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IConfigurationResolverService private readonly variables: IConfigurationResolverService,
		@IWorkspaceContextService protected readonly workspace: IWorkspaceContextService,
		@IEnvironmentVariableService private readonly environmentVariables: IEnvironmentVariableService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.generation++));
		this._register(processes.onConnectionState(() => this.generation++));
	}

	get defaultProfileName(): string | undefined { return this.profiles.getDefaultProfileName(); }
	getDefaultIcon(): ThemeIcon { return ThemeIcon.fromId('terminal'); }

	resolveIcon(shellLaunchConfig: IShellLaunchConfig, os: OperatingSystem): void {
		const profile = shellLaunchConfig.executable ? undefined : this.profiles.getDefaultProfile(os);
		const executable = shellLaunchConfig.executable ?? profile?.path;
		shellLaunchConfig.icon ??= profile?.icon
			?? (typeof executable === 'string' ? this._guessProfileIcon(executable, shellLaunchConfig.args ?? profile?.args) : undefined)
			?? this.getDefaultIcon();
	}

	async getEnvironment(remoteAuthority: string | undefined, workspaceFolder?: IWorkspaceFolder): Promise<Readonly<Record<string, string>>> {
		this.assertAuthority(remoteAuthority);
		const generation = this.generation;
		const folder = this.resolveWorkspaceFolder({ remoteAuthority, os: this.processes.operatingSystem!, workspaceFolder });
		const environment = await this.processes.getEnvironment(undefined, this.folderId(folder));
		this.assertCurrent(generation);
		return environment;
	}

	async getDefaultProfile(options: IShellLaunchConfigResolveOptions): Promise<ITerminalProfile> {
		this.assertOptions(options);
		const folder = this.resolveWorkspaceFolder(options);
		const generation = this.generation;
		await this.profiles.refreshAvailableProfiles(this.folderId(folder));
		this.assertCurrent(generation);
		const platform = await this.profiles.getPlatformKey();
		let profile = this.profiles.getDefaultProfile(options.os, this.folderId(folder));
		const kind = options.allowAgentHostShell ? 'agentHostProfile' : options.allowAutomationShell ? 'automationProfile' : undefined;
		const key = kind === undefined ? undefined : kind === 'automationProfile'
			? `${TerminalSettingPrefix.AutomationProfile}${platform}`
			: `${TERMINAL_CONFIG_SECTION}.${kind}.${platform}`;
		const configured = key ? this.configuration.getValue<ITerminalProfileObject | null>(key, { resource: folder?.uri }) : undefined;
		if (configured?.path) {
			const name = kind === 'agentHostProfile' ? localize('terminal.profile.agentHostShell', 'Agent host shell') : localize('terminal.profile.automationShell', 'Automation shell');
			profile = {
				profileId: `custom:${kind}`, profileName: name, title: name, isDefault: false,
				path: configured.path, args: configured.args, env: configured.env,
				icon: configured.icon ? ThemeIcon.fromId(configured.icon) : undefined, color: configured.color,
			};
		}
		if (!profile) {
			const resolved = await this.processes.resolveProfile({ type: 'default' }, this.folderId(folder));
			this.assertCurrent(generation);
			return { ...resolved.profile, profileName: resolved.profile.title, path: resolved.executable, args: resolved.args };
		}
		const environment = await this.processes.getEnvironment(undefined, this.folderId(folder));
		const resolved = await this.resolveProfile(profile, environment, folder);
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
		const folder = this.resolveWorkspaceFolder(options);
		const overrides: Record<string, string | null> = {};
		mergeEnvironments(overrides, this.configuration.getValue<Readonly<Record<string, string | null>>>(`${TERMINAL_CONFIG_SECTION}.env.${platform}`, { resource: folder?.uri }), options.os !== OperatingSystem.Windows);
		const environment = await this.processes.getEnvironment(undefined, this.folderId(folder));
		const profile = shell.executable
			? await this.resolveProfile({ profileId: 'custom', profileName: shell.name ?? localize('terminal.profile.shell', 'Shell'), title: shell.name ?? localize('terminal.profile.shell', 'Shell'), isDefault: false, path: shell.executable, args: shell.args, env: shell.env, icon: shell.icon, color: shell.color }, environment, folder)
			: await this.getDefaultProfile(options);
		mergeEnvironments(overrides, profile.env, options.os !== OperatingSystem.Windows);
		mergeEnvironments(overrides, shell.env, options.os !== OperatingSystem.Windows);
		const resolve = (value: string) => this.variables.resolveWithEnvironment(environment, folder, value);
		let env: IProcessEnvironment;
		let environmentVariableCollections: IShellLaunchConfig['environmentVariableCollections'] = [];
		let environmentVariableCollectionsPersistable = true;
		if (!shouldUseEnvironmentVariableCollection(shell)) {
			// Strict launch values are literal: no configured, inherited or extension mutations.
			env = Object.fromEntries(Object.entries(shell.env ?? {}).flatMap(([key, value]) => value === null ? [] : [[key, value]]));
		} else {
			await this.environmentVariables.refreshCollections();
			const launchEnv = await createTerminalEnvironment(overrides, resolve);
			env = Object.fromEntries(Object.entries(launchEnv).map(([key, value]) => [key, value ?? undefined]));
			const collection = new MergedEnvironmentVariableCollection(this.environmentVariables.collections, options.os !== OperatingSystem.Windows);
			environmentVariableCollections = serializeEnvironmentVariableCollections(collection.collections);
			environmentVariableCollectionsPersistable = [...this.environmentVariables.collections.values()].every(collection => collection.persistent);
			const scope = { workspaceFolder: folder };
			// Materialize inheritance only for mutated variables. Other host values
			// remain with the Rust spawn owner; null overrides still mean deletion.
			for (const [name, mutations] of collection.getVariableMap(scope)) {
				if (!mutations.some(mutator => mutator.options === undefined || mutator.options.applyAtProcessCreation === true)) continue;
				const sameName = (key: string) => options.os === OperatingSystem.Windows ? key.toLowerCase() === name.toLowerCase() : key === name;
				if (Object.keys(env).some(sameName)) continue;
				const inheritedKey = Object.keys(environment).find(sameName);
				if (inheritedKey) Object.defineProperty(env, inheritedKey, { value: environment[inheritedKey], enumerable: true, configurable: true, writable: true });
			}
			await collection.applyToProcessEnvironment(env, scope, resolve);
		}
		const cwd = shell.cwd ?? this.configuration.getValue<string>(TerminalSettingId.Cwd, { resource: folder?.uri });
		const resolvedCwd = cwd ? sanitizeCwd(await resolve(cwd), options.os) : undefined;
		const resolvedArgs = shell.args === undefined ? profile.args ?? [] : typeof shell.args === 'string' ? await resolve(shell.args) : await Promise.all(shell.args.map(resolve));
		const executable = typeof profile.path === 'string' ? profile.path : profile.path[0]!;
		this.assertCurrent(generation);
		shell.executable = executable;
		shell.args = resolvedArgs;
		shell.env = Object.freeze(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null])));
		shell.environmentVariableCollections = environmentVariableCollections;
		shell.environmentVariableCollectionsPersistable = environmentVariableCollectionsPersistable;
		shell.cwd = resolvedCwd;
		shell.icon ??= profile.icon ?? this._guessProfileIcon(executable, resolvedArgs) ?? this.getDefaultIcon();
		shell.color ??= profile.color;
		if (profile.overrideName && shell.name === undefined) shell.name = profile.profileName;
	}

	private async resolveProfile(profile: ITerminalProfile, environment: Readonly<Record<string, string>>, folder: IWorkspaceFolder | undefined): Promise<ITerminalProfile> {
		const resolve = (value: string) => this.variables.resolveWithEnvironment(environment, folder, value);
		const path = await Promise.all((typeof profile.path === 'string' ? [profile.path] : profile.path).map(value => resolve(value.replace(/^~(?=$|[/\\])/, '${userHome}'))));
		if (typeof profile.args === 'string' && this.processes.operatingSystem !== OperatingSystem.Windows) {
			throw new Error(localize('terminal.profile.windowsCommandLine', 'Raw command line strings are only supported on Windows.'));
		}
		const args = typeof profile.args === 'string' ? await resolve(profile.args) : await Promise.all((profile.args ?? []).map(resolve));
		const result = await this.processes.resolveProfile({ type: 'custom', name: profile.profileName, path, args }, this.folderId(folder));
		return { ...profile, path: result.executable, args: result.args };
	}

	private resolveWorkspaceFolder(options: IShellLaunchConfigResolveOptions): IWorkspaceFolder | undefined {
		const folders = this.workspace.getWorkspace().folders;
		if (options.workspaceFolder) {
			const folder = folders.find(folder => folder.id === options.workspaceFolder!.id);
			if (!folder) throw new CancellationError();
			return folder;
		}
		if (folders.length > 1) throw new Error(localize('terminal.selectFolder', 'Select a workspace folder for the terminal.'));
		return folders[0];
	}

	private folderId(folder: IWorkspaceFolder | undefined): string | undefined {
		return folder?.id;
	}

	/** Uses execution-host launch data; profile and terminal titles are user-editable. */
	private _guessProfileIcon(executable: string, args: TerminalArguments | undefined): ThemeIcon | undefined {
		const program = executable.split(/[/\\]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase();
		if (/^ubuntu(?:\d{4})?$/.test(program)) return Lxicon.terminalUbuntu;
		switch (program) {
			case 'pwsh':
			case 'powershell':
				return Lxicon.terminalPowershell;
			case 'cmd':
				return Lxicon.terminalCmd;
			case 'wsl': {
				const distribution = wslDistribution(args);
				return distribution && /ubuntu/i.test(distribution) ? Lxicon.terminalUbuntu : undefined;
			}
			default:
				return undefined;
		}
	}

	protected abstract getExecutionAuthority(): string | undefined;

	private assertAuthority(remoteAuthority: string | undefined): void {
		if (this.isDisposed) throw new CancellationError();
		const authority = this.getExecutionAuthority();
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

/** Browser execution follows the resource selected by its embedder. */
export class BrowserTerminalProfileResolverService extends BaseTerminalProfileResolverService {
	protected getExecutionAuthority(): string | undefined {
		const folder = this.workspace.getWorkspace().folders[0];
		return folder?.uri.scheme === 'ash-remote' ? folder.uri.authority : undefined;
	}
}

function wslDistribution(args: TerminalArguments | undefined): string | undefined {
	const argv = typeof args === 'string' ? windowsArguments(args) : args ?? [];
	for (let index = 0; index < argv.length; index++) {
		switch (argv[index]) {
			case '-d':
			case '--distribution':
				return argv[index + 1];
			case '--cd':
			case '-u':
			case '--user':
			case '--shell-type':
				index++;
				break;
			default:
				// Exec, -- and positional commands end WSL option parsing. Their arguments
				// may mention Ubuntu without selecting an Ubuntu distribution.
				return undefined;
		}
	}
	return undefined;
}

/** Reads a Windows command-line tail for icon inference without changing the launch string. */
function windowsArguments(commandLine: string): string[] {
	const argv: string[] = [];
	let argument = '';
	let quoted = false;
	let started = false;
	for (let index = 0; index < commandLine.length; index++) {
		const character = commandLine[index];
		if (!quoted && (character === ' ' || character === '\t')) {
			if (started) argv.push(argument);
			argument = '';
			started = false;
			continue;
		}
		started = true;
		if (character === '\\') {
			let backslashes = 1;
			while (commandLine[index + 1] === '\\') {
				backslashes++;
				index++;
			}
			if (commandLine[index + 1] === '"') {
				argument += '\\'.repeat(Math.floor(backslashes / 2));
				if (backslashes % 2) {
					argument += '"';
					index++;
				}
			} else {
				argument += '\\'.repeat(backslashes);
			}
		} else if (character === '"') {
			if (quoted && commandLine[index + 1] === '"') {
				argument += '"';
				index++;
			} else {
				quoted = !quoted;
			}
		} else {
			argument += character;
		}
	}
	if (started) argv.push(argument);
	return argv;
}
