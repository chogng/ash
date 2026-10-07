import type { Icon } from "../../../base/common/icon.js";
import type {
	ContextKeyExpression,
} from "../../contextkey/common/contextkey.js";
import type { ICommandMetadata } from "../../commands/common/commands.js";
import type { ILocalizedString } from '../../../nls.js';
export type { ILocalizedString } from '../../../nls.js';

export type CommandActionTitle = string | ILocalizedString;

export interface ICommandActionToggleInfo {
	readonly condition: ContextKeyExpression;
	readonly icon?: Icon;
	readonly tooltip?: CommandActionTitle;
	readonly title?: CommandActionTitle;
}

/**
 * Static command presentation metadata.
 *
 * The command handler is registered separately so the same command can be
 * invoked from a toolbar, menu, keybinding, or programmatic call.
 */
export interface ICommandAction {
	readonly id: string;
	readonly title: CommandActionTitle;
	readonly metadata?: ICommandMetadata;
	readonly shortTitle?: CommandActionTitle;
	readonly tooltip?: CommandActionTitle;
	readonly icon?: Icon;
	readonly precondition?: ContextKeyExpression;
	readonly toggled?: ContextKeyExpression | ICommandActionToggleInfo;
}

export function commandActionLabel(title: CommandActionTitle): string {
	return typeof title === 'string' ? title : title.value;
}

export function isCommandActionToggleInfo(
	value: ContextKeyExpression | ICommandActionToggleInfo,
): value is ICommandActionToggleInfo {
	return "condition" in value;
}
