import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const TerminalCreatingContext = new RawContextKey<boolean>("terminalCreating", false);
export const TerminalHasActiveInstanceContext = new RawContextKey<boolean>("terminalHasActiveInstance", false);
export const TerminalActiveInstanceInTitleContext = new RawContextKey<boolean>("terminalActiveInstanceInTitle", false);
export const TerminalActiveInstanceStateContext = new RawContextKey<string>("terminalActiveInstanceState", "none");

export namespace TerminalContextKeys {
	export const focus = new RawContextKey<boolean>('terminalFocus', false);
	export const findFocus = new RawContextKey<boolean>('terminalFindFocused', false);
	export const findVisible = new RawContextKey<boolean>('terminalFindVisible', false);
}
