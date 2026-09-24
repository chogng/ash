import { Emitter, type Event } from "../../../base/common/event.js";
import {
	decodeKeybinding,
	type Keybinding,
} from "../../../base/common/keybindings.js";
import {
	type IDisposable,
	toDisposable,
} from "../../../base/common/lifecycle.js";
import type {
	CommandId,
} from "../../commands/common/commands.js";
import type {
	ContextKeyExpression,
} from "../../contextkey/common/contextkey.js";
import { operatingSystem } from "../../../base/common/platform.js";

export const enum KeybindingWeight {
	EditorCore = 0,
	EditorContrib = 100,
	WorkbenchContrib = 200,
	SessionsContrib = 250,
	BuiltinExtension = 300,
	ExternalExtension = 400,
}

export enum KeybindingSource {
	Builtin = 0,
	Workbench = 1,
	User = 2,
}

export enum KeybindingRuleKind {
	Command = "command",
	Blocker = "blocker",
}

/** One command shortcut contribution before host-specific resolution. */
export interface IKeybindingRule {
	readonly command: CommandId;
	readonly keybinding: Keybinding | number | readonly number[];
	readonly when?: ContextKeyExpression;
	readonly args?: readonly unknown[];
	readonly source?: KeybindingSource;
	readonly priority?: number;
}

/** Explicitly consumes a shortcut without dispatching a command. */
export interface IKeybindingBlocker {
	readonly keybinding: Keybinding | number | readonly number[];
	readonly when?: ContextKeyExpression;
	readonly source?: KeybindingSource;
	readonly priority?: number;
}

export interface IRegisteredCommandKeybindingRule
	extends IKeybindingRule {
	readonly kind: KeybindingRuleKind.Command;
	readonly keybinding: Keybinding;
	readonly order: number;
}

export interface IRegisteredKeybindingBlocker
	extends IKeybindingBlocker {
	readonly kind: KeybindingRuleKind.Blocker;
	readonly keybinding: Keybinding;
	readonly order: number;
}

export type IRegisteredKeybindingRule =
	| IRegisteredCommandKeybindingRule
	| IRegisteredKeybindingBlocker;

/** Stores realm-wide keybinding contributions and their override order. */
export class KeybindingRegistry {
	private readonly rules: IRegisteredKeybindingRule[] = [];
	private readonly _onDidChangeKeybindings = new Emitter<void>();
	private nextOrder = 1;

	readonly onDidChangeKeybindings: Event<void> =
		this._onDidChangeKeybindings.event;

	registerKeybindingRule(rule: IKeybindingRule): IDisposable {
		const registered: IRegisteredCommandKeybindingRule = {
			...rule,
			keybinding: resolveKeybinding(rule.keybinding),
			kind: KeybindingRuleKind.Command,
			order: this.nextOrder++,
		};
		return this.register(registered);
	}

	registerKeybindingBlocker(
		blocker: IKeybindingBlocker,
	): IDisposable {
		const registered: IRegisteredKeybindingBlocker = {
			...blocker,
			keybinding: resolveKeybinding(blocker.keybinding),
			kind: KeybindingRuleKind.Blocker,
			order: this.nextOrder++,
		};
		return this.register(registered);
	}

	private register(registered: IRegisteredKeybindingRule): IDisposable {
		this.rules.push(registered);
		this._onDidChangeKeybindings.fire();
		return toDisposable(() => {
			const index = this.rules.indexOf(registered);
			if (index < 0) return;
			this.rules.splice(index, 1);
			this._onDidChangeKeybindings.fire();
		});
	}

	getKeybindings(): readonly IRegisteredKeybindingRule[] {
		return [...this.rules];
	}
}

/** Realm-wide keybinding contributions populated by action modules. */
export const KeybindingsRegistry = new KeybindingRegistry();

function resolveKeybinding(value: Keybinding | number | readonly number[]): Keybinding {
	if (typeof value === "object" && !Array.isArray(value)) return value as Keybinding;
	const decoded = decodeKeybinding(value as number | readonly number[], operatingSystem);
	if (!decoded) throw new TypeError("Keybinding must not be empty");
	return decoded;
}
