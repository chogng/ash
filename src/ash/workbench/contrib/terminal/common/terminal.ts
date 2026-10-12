import { MarshalledId } from '../../../../base/common/marshallingIds.js';

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
	ScrollToPreviousCommand = 'workbench.action.terminal.scrollToPreviousCommand',
	ScrollToNextCommand = 'workbench.action.terminal.scrollToNextCommand',
	CopySelection = 'workbench.action.terminal.copySelection',
	CopyAndClearSelection = 'workbench.action.terminal.copyAndClearSelection',
	Paste = 'workbench.action.terminal.paste',
	PasteSelection = 'workbench.action.terminal.pasteSelection',
}

export const TERMINAL_VIEW_ID = "ash.terminal";
