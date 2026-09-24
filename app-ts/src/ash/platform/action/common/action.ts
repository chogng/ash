import type { Icon } from "../../../base/common/icon.js";
import type {
	ContextKeyExpression,
} from "../../contextkey/common/contextkey.js";
import type { ICommandMetadata } from "../../commands/common/commands.js";
import { localize } from "../../../nls.js";

export interface ILocalizedString {
	readonly value: string;
	readonly original: string;
	readonly bundle?: string;
	readonly key?: string;
}

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

export function localizedString(bundle: string, key: string, original: string): ILocalizedString {
	return Object.freeze({ value: original, original, bundle, key });
}

export function commandActionLabel(title: CommandActionTitle): string {
	if (typeof title === "string") return title;
	return title.key ? localize(title.key, title.original) : title.value;
}

export function isCommandActionToggleInfo(
	value: ContextKeyExpression | ICommandActionToggleInfo,
): value is ICommandActionToggleInfo {
	return "condition" in value;
}
