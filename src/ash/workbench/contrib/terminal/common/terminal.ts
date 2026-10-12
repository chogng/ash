import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { OperatingSystem } from '../../../../base/common/platform.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalProcessProfile } from '../../../../platform/terminal/common/terminal.js';

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
	readonly availableProfiles: readonly ITerminalProcessProfile[];
	readonly onDidChangeAvailableProfiles: Event<readonly ITerminalProcessProfile[]>;
	refreshAvailableProfiles(): Promise<void>;
	getPlatformKey(): Promise<'linux' | 'osx' | 'windows'>;
	getDefaultProfileName(): string | undefined;
	getDefaultProfile(os?: OperatingSystem): ITerminalProcessProfile | undefined;
}

export const ITerminalProfileService = createServiceIdentifier<ITerminalProfileService>('terminalProfileService');

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
