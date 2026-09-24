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

/** Provides resolved shortcuts for command presentation and dispatch. */
export interface IKeybindingService {
	readonly inChordMode: boolean;
	readonly onDidUpdateKeybindings: Event<void>;

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
