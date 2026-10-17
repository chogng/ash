import type { ITerminalProcessCreation, ITerminalReconnectLease } from '../../../../platform/terminal/common/terminal.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICreateContributedTerminalProfileOptions, IExtensionTerminalProfile, IShellLaunchConfig, ITerminalProfile, TerminalArguments } from '../../../../platform/terminal/common/terminal.js';
import type { OperatingSystem } from '../../../../base/common/platform.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type Severity from '../../../../base/common/severity.js';

export interface ITerminalStatus {
	readonly id: string;
	readonly severity: Severity;
	readonly tooltip: string;
}

export interface ITerminalContributionService extends IDisposable {
	readonly terminalProfiles: readonly IExtensionTerminalProfile[];
	readonly onDidChangeTerminalProfiles: Event<readonly IExtensionTerminalProfile[]>;
}

export const ITerminalContributionService = createServiceIdentifier<ITerminalContributionService>('terminalContributionService');

/** Available trusted shells and the effective interactive default in this window. */
export interface ITerminalProfileService extends IDisposable {
	readonly availableProfiles: readonly ITerminalProfile[];
	readonly contributedProfiles: readonly IExtensionTerminalProfile[];
	readonly profilesReady: Promise<void>;
	readonly onDidChangeAvailableProfiles: Event<readonly ITerminalProfile[]>;
	refreshAvailableProfiles(): Promise<void>;
	getPlatformKey(): Promise<'linux' | 'osx' | 'windows'>;
	getDefaultProfileName(): string | undefined;
	getDefaultProfile(os?: OperatingSystem): ITerminalProfile | undefined;
	getContributedDefaultProfile(shellLaunchConfig: IShellLaunchConfig): Promise<IExtensionTerminalProfile | undefined>;
	registerContributedProfile(args: IRegisterContributedProfileArgs): Promise<void>;
	registerInternalContributedProfile(profile: IExtensionTerminalProfile): IDisposable;
	getContributedProfileProvider(extensionIdentifier: string, id: string): ITerminalProfileProvider | undefined;
	registerTerminalProfileProvider(extensionIdentifier: string, id: string, provider: ITerminalProfileProvider): IDisposable;
	overrideDefaultProfile(extensionIdentifier: string, id: string): IDisposable;
}

export const ITerminalProfileService = createServiceIdentifier<ITerminalProfileService>('terminalProfileService');

export interface IRegisterContributedProfileArgs extends IExtensionTerminalProfile {
	readonly options: ICreateContributedTerminalProfileOptions;
}

export interface ITerminalProfileProvider {
	createContributedTerminalProfile(options: ICreateContributedTerminalProfileOptions): Promise<void>;
}

export interface IShellLaunchConfigResolveOptions {
	readonly remoteAuthority: string | undefined;
	readonly os: OperatingSystem;
	readonly allowAutomationShell?: boolean;
	readonly allowAgentHostShell?: boolean;
}

export interface ITerminalProfileResolverService {
	readonly defaultProfileName: string | undefined;
	resolveIcon(shellLaunchConfig: IShellLaunchConfig, os: OperatingSystem): void;
	resolveShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig, options: IShellLaunchConfigResolveOptions): Promise<void>;
	getDefaultProfile(options: IShellLaunchConfigResolveOptions): Promise<ITerminalProfile>;
	getDefaultShell(options: IShellLaunchConfigResolveOptions): Promise<string>;
	getDefaultShellArgs(options: IShellLaunchConfigResolveOptions): Promise<TerminalArguments>;
	getDefaultIcon(): ThemeIcon;
	getEnvironment(remoteAuthority: string | undefined): Promise<Readonly<Record<string, string>>>;
}

export const ITerminalProfileResolverService = createServiceIdentifier<ITerminalProfileResolverService>('terminalProfileResolverService');


/** One immutable screen checkpoint, never a second live process or layout model. */
export interface ITerminalSerializedState {
	readonly instanceId: number;
	readonly resource: string;
	readonly dirId: string;
	readonly processDirId?: string;
	readonly process: ITerminalProcessCreation;
	readonly title: string;
	readonly customTitle?: string;
	readonly target: number;
	readonly cols: number;
	readonly rows: number;
	readonly sequence: number;
	readonly pendingUtf8: readonly number[];
	readonly vt: string;
}

export interface ITerminalReloadState {
	readonly version: 1;
	readonly workspaceId: string;
	readonly remoteAuthority?: string;
	readonly instances: readonly ITerminalSerializedState[];
	readonly groups: readonly { readonly ids: readonly number[]; readonly sizes: readonly number[]; }[];
	readonly activeId?: number;
	readonly focusedId?: number;
}

export interface ITerminalReloadCredentials {
	readonly stateKey: string;
	readonly expiresAt: number;
	readonly leases: readonly ITerminalReconnectLease[];
}

