import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICreateContributedTerminalProfileOptions, IExtensionTerminalProfile, IShellLaunchConfig, ITerminalProfile, TerminalArguments } from '../../../../platform/terminal/common/terminal.js';
import type { OperatingSystem } from '../../../../base/common/platform.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type Severity from '../../../../base/common/severity.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

import { MarshalledId } from '../../../../base/common/marshallingIds.js';

export const TERMINAL_CONFIG_SECTION = 'terminal.integrated';

/** Presentation settings with active screen consumers. */
export interface ITerminalConfiguration {
	readonly fontFamily: string;
	readonly fontRendering: 'auto' | 'grayscale';
	readonly fontSize: number;
	readonly letterSpacing: number;
	readonly lineHeight: number;
	readonly cursorBlinking: boolean;
	readonly cursorStyle: 'block' | 'line' | 'underline';
	readonly cursorStyleInactive: 'outline' | 'block' | 'line' | 'underline' | 'none';
	readonly cursorWidth: number;
	readonly scrollback: number;
	readonly minimumContrastRatio: number;
	readonly showLinkHover: boolean;
}

export interface ISerializedTerminalInstanceContext {
	readonly $mid: MarshalledId.TerminalContext;
	readonly instanceId: number;
}

export const enum TerminalCommandId {
	Rename = 'workbench.action.terminal.rename',
	ChangeIcon = 'workbench.action.terminal.changeIcon',
	MoveToEditor = 'workbench.action.terminal.moveToEditor',
	MoveIntoNewWindow = 'workbench.action.terminal.moveIntoNewWindow',
	MoveToTerminalPanel = 'workbench.action.terminal.moveToTerminalPanel',
	New = 'workbench.action.terminal.new',
	NewInNewWindow = 'workbench.action.terminal.newInNewWindow',
	ConfigureTerminalSettings = 'workbench.action.terminal.openSettings',
	NewWithProfile = 'workbench.action.terminal.newWithProfile',
	SelectDefaultProfile = 'workbench.action.terminal.selectDefaultProfile',
	Relaunch = 'workbench.action.terminal.relaunch',
	Kill = 'workbench.action.terminal.kill',
	Clear = 'workbench.action.terminal.clear',
	Focus = 'workbench.action.terminal.focus',
	ScrollToPreviousCommand = 'workbench.action.terminal.scrollToPreviousCommand',
	ScrollToNextCommand = 'workbench.action.terminal.scrollToNextCommand',
	CopySelection = 'workbench.action.terminal.copySelection',
	CopyAndClearSelection = 'workbench.action.terminal.copyAndClearSelection',
	Paste = 'workbench.action.terminal.paste',
	PasteSelection = 'workbench.action.terminal.pasteSelection',
	SendSequence = 'workbench.action.terminal.sendSequence',
	SendSignal = 'workbench.action.terminal.sendSignal',
	RunSelectedText = 'workbench.action.terminal.runSelectedText',
	RunActiveFile = 'workbench.action.terminal.runActiveFile',
	Split = 'workbench.action.terminal.split',
	Unsplit = 'workbench.action.terminal.unsplit',
	Join = 'workbench.action.terminal.join',
	FocusNextPane = 'workbench.action.terminal.focusNextPane',
	FocusPreviousPane = 'workbench.action.terminal.focusPreviousPane',
}

export const TERMINAL_VIEW_ID = "ash.terminal";

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
	refreshAvailableProfiles(dirId?: string): Promise<void>;
	getPlatformKey(): Promise<'linux' | 'osx' | 'windows'>;
	getDefaultProfileName(): string | undefined;
	getDefaultProfile(os?: OperatingSystem, dirId?: string): ITerminalProfile | undefined;
	getAvailableProfiles(dirId?: string): readonly ITerminalProfile[];
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
	/** Returns the created instance ID, or undefined when the provider cancels. */
	createContributedTerminalProfile(options: ICreateContributedTerminalProfileOptions): Promise<number | undefined>;
}

export interface IShellLaunchConfigResolveOptions {
	readonly workspaceFolder?: IWorkspaceFolder;
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
	getEnvironment(remoteAuthority: string | undefined, workspaceFolder?: IWorkspaceFolder): Promise<Readonly<Record<string, string>>>;
}

export const ITerminalProfileResolverService = createServiceIdentifier<ITerminalProfileResolverService>('terminalProfileResolverService');
