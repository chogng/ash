import assert from "node:assert/strict";
import { test } from "mocha";
import type { KeybindingEvent } from "../../../../base/common/keybindings.js";
import { resolveKeybinding } from "../../../../base/common/keybindings.js";
import { parseKeybinding } from "../../../../base/common/keybindingParser.js";
import { OperatingSystem } from "../../../../base/common/platform.js";
import { loadKeybindingConformanceFixtures } from "../../../../base/test/common/keybindingConformanceFixtures.js";
import type { Context } from "../../../contextkey/common/contextkey.js";
import type { ContextKeyValue } from "../../../contextkey/common/contextkey.js";
import { ContextKeyExpr } from "../../../contextkey/common/contextkey.js";
import { KeybindingResolveKind } from "../../common/keybindingResolver.js";
import { KeybindingResolver } from "../../common/keybindingResolver.js";
import { KeybindingRegistry } from "../../common/keybindingsRegistry.js";
import { KeybindingSource } from "../../common/keybindingsRegistry.js";

interface ConformanceFixtures {
	readonly resolver: readonly ResolverFixture[];
}

interface ResolverFixture {
	readonly name: string;
	readonly context?: readonly string[];
	readonly events: readonly EventFixture[];
	readonly rules: readonly RuleFixture[];
	readonly result: {
		readonly kind: "noMatch" | "pending" | "command" | "blocked";
		readonly command?: string;
	};
}

interface EventFixture {
	readonly key: string;
	readonly control?: boolean;
	readonly shift?: boolean;
	readonly alt?: boolean;
	readonly meta?: boolean;
}

interface RuleFixture {
	readonly binding: string;
	readonly command?: string;
	readonly block?: boolean;
	readonly source: "builtin" | "workbench" | "user";
	readonly priority: number;
	readonly when?: string;
}

test("shared keybinding resolver fixtures match the TypeScript implementation", () => {
	const fixtures = loadFixtures();
	for (const fixture of fixtures.resolver) {
		const registry = new KeybindingRegistry();
		for (const rule of fixture.rules) {
			const keybinding = parseKeybinding(rule.binding);
			assert.ok(keybinding, `${fixture.name}: invalid binding`);
			const contribution = {
				keybinding,
				when: rule.when ? ContextKeyExpr.has(rule.when) : undefined,
				source: keybindingSource(rule.source),
				priority: rule.priority,
			};
			if (rule.block) {
				registry.registerKeybindingBlocker(contribution);
			} else {
				assert.ok(rule.command, `${fixture.name}: command rule has no command`);
				registry.registerKeybindingRule({
					...contribution,
					command: rule.command,
				});
			}
		}
		const resolver = new KeybindingResolver({
			registry,
			resolveKeybinding: (keybinding) =>
				resolveKeybinding(keybinding, OperatingSystem.Windows),
		});
		const activeKeys = new Set(fixture.context ?? []);
		const context: Context = {
			getValue: <T extends ContextKeyValue>(key: string): T | undefined =>
				activeKeys.has(key) as T,
		};
		const result = resolver.resolve(
			context,
			fixture.events.map(keybindingEvent),
		);
		assert.equal(resultKind(result.kind), fixture.result.kind, fixture.name);
		assert.equal(
			result.kind === KeybindingResolveKind.Command
				? result.command
				: undefined,
			fixture.result.command,
			fixture.name,
		);
	}
});

function loadFixtures(): ConformanceFixtures {
	return loadKeybindingConformanceFixtures<ConformanceFixtures>();
}

function keybindingSource(source: RuleFixture["source"]): KeybindingSource {
	switch (source) {
		case "builtin":
			return KeybindingSource.Builtin;
		case "workbench":
			return KeybindingSource.Workbench;
		case "user":
			return KeybindingSource.User;
	}
}

function keybindingEvent(event: EventFixture): KeybindingEvent {
	return {
		key: event.key,
		code: "",
		ctrlKey: Boolean(event.control),
		shiftKey: Boolean(event.shift),
		altKey: Boolean(event.alt),
		metaKey: Boolean(event.meta),
	};
}

function resultKind(kind: KeybindingResolveKind): ResolverFixture["result"]["kind"] {
	switch (kind) {
		case KeybindingResolveKind.NoMatch:
			return "noMatch";
		case KeybindingResolveKind.MoreChordsNeeded:
			return "pending";
		case KeybindingResolveKind.Command:
			return "command";
		case KeybindingResolveKind.Blocked:
			return "blocked";
	}
}
