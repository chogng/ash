import type { JsonValue } from '../../../base/common/jsonValue.js';
import type { ResolvedKeybindingItem } from './resolvedKeybindingItem.js';
import type { JsonSchema } from '../../../base/common/jsonSchema.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type {
	Event,
} from "../../../base/common/event.js";
import type {
	Keybinding,
	ResolvedKeybinding,
} from "../../../base/common/keybindings.js";
import type {
	CommandId,
} from "../../commands/common/commands.js";
import type {
	Context,
} from "../../contextkey/common/contextkey.js";
import { RawContextKey } from "../../contextkey/common/contextkey.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";

/** One ordered shortcut rule from the active `keybindings.json`. */
export interface IUserFriendlyKeybinding {
	readonly key: string;
	readonly command: CommandId | null;
	readonly when?: string;
	readonly args?: JsonValue;
	readonly mac?: string | null;
	readonly linux?: string | null;
	readonly win?: string | null;
	readonly systemWide?: boolean;
}

export interface KeybindingsSchemaContribution {
	readonly onDidChange?: Event<void>;
	getSchemaAdditions(): JsonSchema[];
}

/** Provides resolved shortcuts for command presentation and dispatch. */
export interface IKeybindingService {
	readonly inChordMode: boolean;
	readonly onDidUpdateKeybindings: Event<void>;
	getKeybindings(): readonly ResolvedKeybindingItem[];

	registerSchemaContribution(contribution: KeybindingsSchemaContribution): IDisposable;

	resolveKeybinding(keybinding: Keybinding): ResolvedKeybinding;
	resolveUserBinding(userBinding: string): ResolvedKeybinding | undefined;
	lookupKeybindings(
		command: CommandId,
		context?: Context,
	): readonly ResolvedKeybinding[];
	lookupKeybinding(
		command: CommandId,
		context?: Context,
	): ResolvedKeybinding | undefined;
}

export const IKeybindingService =
	createServiceIdentifier<IKeybindingService>("keybindingService");

/** Shared context identities used by keybinding dispatch and recording UIs. */
export const KeybindingContextKeys = {
	inChordMode: new RawContextKey<boolean>(
		"keybinding.inChordMode",
		false,
	),
	isComposing: new RawContextKey<boolean>(
		"keybinding.isComposing",
		false,
	),
	isRecording: new RawContextKey<boolean>(
		"keybinding.isRecording",
		false,
	),
};
