import {
	type Keybinding,
	type KeybindingEvent,
	matchesResolvedChord,
	type ResolvedKeybinding,
	resolveKeybinding,
} from "../../../base/common/keybindings.js";
import type { Event } from "../../../base/common/event.js";
import type {
	CommandId,
} from "../../commands/common/commands.js";
import type {
	Context,
} from "../../contextkey/common/contextkey.js";
import {
	type IRegisteredKeybindingRule,
	type KeybindingRegistry,
	KeybindingsRegistry,
	KeybindingRuleKind,
	KeybindingSource,
} from "./keybindingsRegistry.js";

export enum KeybindingResolveKind {
	NoMatch = "noMatch",
	MoreChordsNeeded = "moreChordsNeeded",
	Command = "command",
	Blocked = "blocked",
}

export type KeybindingResolveResult =
	| { readonly kind: KeybindingResolveKind.NoMatch }
	| {
		readonly kind: KeybindingResolveKind.MoreChordsNeeded;
		readonly keybinding: ResolvedKeybinding;
	}
	| {
		readonly kind: KeybindingResolveKind.Command;
		readonly command: CommandId;
		readonly args: readonly unknown[];
		readonly keybinding: ResolvedKeybinding;
	}
	| {
		readonly kind: KeybindingResolveKind.Blocked;
		readonly keybinding: ResolvedKeybinding;
	};

interface ResolvedRule {
	readonly rule: IRegisteredKeybindingRule;
	readonly keybinding: ResolvedKeybinding;
}

export interface KeybindingResolverOptions {
	readonly registry?: KeybindingRegistry;
	readonly resolveKeybinding?: (
		keybinding: Keybinding,
	) => ResolvedKeybinding | readonly ResolvedKeybinding[];
}

/**
 * Resolves command conflicts and multi-chord prefixes against one context.
 */
export class KeybindingResolver {
	private readonly registry: KeybindingRegistry;
	private readonly resolveKeybinding: (
		keybinding: Keybinding,
	) => ResolvedKeybinding | readonly ResolvedKeybinding[];

	constructor(options: KeybindingResolverOptions = {}) {
		this.registry = options.registry ?? KeybindingsRegistry;
		this.resolveKeybinding = options.resolveKeybinding ??
			((keybinding) => resolveKeybinding(keybinding));
	}

	get onDidChangeKeybindings(): Event<void> {
		return this.registry.onDidChangeKeybindings;
	}

	resolve(
		context: Context,
		events: readonly KeybindingEvent[],
	): KeybindingResolveResult {
		if (events.length === 0) {
			return { kind: KeybindingResolveKind.NoMatch };
		}

		const candidates = this.resolvedRules()
			.filter(({ rule, keybinding }) =>
				(!rule.when || rule.when.evaluate(context)) &&
				keybinding.chords.length >= events.length &&
				events.every((event, index) =>
					matchesResolvedChord(keybinding.chords[index], event)
				)
			)
			.sort(compareResolvedRules);
		const winner = candidates[0];
		if (!winner) return { kind: KeybindingResolveKind.NoMatch };

		if (winner.keybinding.chords.length > events.length) {
			return {
				kind: KeybindingResolveKind.MoreChordsNeeded,
				keybinding: winner.keybinding,
			};
		}
		if (winner.rule.kind === KeybindingRuleKind.Blocker) {
			return {
				kind: KeybindingResolveKind.Blocked,
				keybinding: winner.keybinding,
			};
		}
		return {
			kind: KeybindingResolveKind.Command,
			command: winner.rule.command,
			args: winner.rule.args ?? [],
			keybinding: winner.keybinding,
		};
	}

	lookupKeybinding(
		command: CommandId,
		context: Context,
	): ResolvedKeybinding | undefined {
		return this.winningRules(context)
			.find(({ rule }) =>
				rule.kind === KeybindingRuleKind.Command &&
				rule.command === command
			)?.keybinding;
	}

	lookupKeybindings(
		command: CommandId,
		context: Context,
	): readonly ResolvedKeybinding[] {
		return this.winningRules(context)
			.filter(({ rule }) =>
				rule.kind === KeybindingRuleKind.Command &&
				rule.command === command
			)
			.map(({ keybinding }) => keybinding);
	}

	private winningRules(context: Context): readonly ResolvedRule[] {
		const winners = new Map<string, ResolvedRule>();
		for (
			const candidate of this.resolvedRules()
				.filter(({ rule }) =>
					!rule.when || rule.when.evaluate(context)
				)
				.sort(compareResolvedRules)
		) {
			const identity = keybindingIdentity(candidate.keybinding);
			if (!winners.has(identity)) winners.set(identity, candidate);
		}
		return [...winners.values()];
	}

	private resolvedRules(): readonly ResolvedRule[] {
		const result: ResolvedRule[] = [];
		for (const rule of this.registry.getKeybindings()) {
			const resolved = this.resolveKeybinding(rule.keybinding);
			const keybindings = Array.isArray(resolved) ? resolved : [resolved];
			for (const keybinding of keybindings) {
				result.push({ rule, keybinding });
			}
		}
		return result;
	}
}

function keybindingIdentity(keybinding: ResolvedKeybinding): string {
	return keybinding.chords.map((chord) => [
		chord.kind,
		chord.key,
		Number(chord.ctrlKey),
		Number(chord.shiftKey),
		Number(chord.altKey),
		Number(chord.metaKey),
	].join(":")).join(" ");
}

function compareResolvedRules(
	first: ResolvedRule,
	second: ResolvedRule,
): number {
	const source = (second.rule.source ?? KeybindingSource.Workbench) -
		(first.rule.source ?? KeybindingSource.Workbench);
	if (source !== 0) return source;
	const priority = (second.rule.priority ?? 0) - (first.rule.priority ?? 0);
	return priority !== 0 ? priority : second.rule.order - first.rule.order;
}
