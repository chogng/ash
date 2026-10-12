import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICreateContributedTerminalProfileOptions, IExtensionTerminalProfile, IShellLaunchConfig, ITerminalProfile } from '../../../../platform/terminal/common/terminal.js';
import type { OperatingSystem } from '../../../../base/common/platform.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';

export const TERMINAL_CONFIG_SECTION = 'terminal.integrated';

/** Presentation settings with active screen consumers. */
export interface ITerminalConfiguration {
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly letterSpacing: number;
	readonly lineHeight: number;
	readonly cursorBlinking: boolean;
	readonly cursorStyle: 'block' | 'line' | 'underline';
	readonly cursorStyleInactive: 'outline' | 'block' | 'line' | 'underline' | 'none';
	readonly cursorWidth: number;
	readonly scrollback: number;
	readonly minimumContrastRatio: number;
}

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
	getDefaultShellArgs(options: IShellLaunchConfigResolveOptions): Promise<readonly string[]>;
	getDefaultIcon(): ThemeIcon;
	getEnvironment(remoteAuthority: string | undefined): Promise<Readonly<Record<string, string>>>;
}

export const ITerminalProfileResolverService = createServiceIdentifier<ITerminalProfileResolverService>('terminalProfileResolverService');

export interface ISerializedTerminalInstanceContext {
	readonly $mid: MarshalledId.TerminalContext;
	readonly instanceId: number;
}

export const enum TerminalCommandId {
	New = 'workbench.action.terminal.new',
	NewWithProfile = 'workbench.action.terminal.newWithProfile',
	SelectDefaultProfile = 'workbench.action.terminal.selectDefaultProfile',
	Relaunch = 'workbench.action.terminal.relaunch',
	Kill = 'workbench.action.terminal.kill',
	Clear = 'workbench.action.terminal.clear',
	Focus = 'workbench.action.terminal.focus',
	CopySelection = 'workbench.action.terminal.copySelection',
	CopyAndClearSelection = 'workbench.action.terminal.copyAndClearSelection',
	Paste = 'workbench.action.terminal.paste',
	PasteSelection = 'workbench.action.terminal.pasteSelection',
}

export const TERMINAL_VIEW_ID = "ash.terminal";
