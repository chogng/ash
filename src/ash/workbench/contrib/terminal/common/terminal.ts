import { MarshalledId } from '../../../../base/common/marshallingIds.js';

export interface ISerializedTerminalInstanceContext {
	readonly $mid: MarshalledId.TerminalContext;
	readonly instanceId: number;
}

export const enum TerminalCommandId {
	New = 'workbench.action.terminal.new',
	NewWithProfile = 'workbench.action.terminal.newWithProfile',
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
