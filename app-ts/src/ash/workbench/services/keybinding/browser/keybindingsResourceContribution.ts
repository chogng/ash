import {
	combinedDisposable,
	Disposable,
	MutableDisposable,
	type IDisposable,
} from "../../../../base/common/lifecycle.js";
import { parseKeybinding } from "../../../../base/common/keybindingParser.js";
import {
	environment,
	type HostOperatingSystem,
} from "../../../../base/common/platform.js";
import {
	parseContextKeyExpression,
} from "../../../../platform/contextkey/common/contextKeyExpressionParser.js";
import {
	type KeybindingRegistry,
	KeybindingsRegistry,
	KeybindingSource,
} from "../../../../platform/keybinding/common/keybindingsRegistry.js";
import type {
	IKeybindingEntry,
	IKeybindingsResourceService,
} from "../../../../platform/keybinding/common/keybindingsResource.js";

export interface KeybindingsResourceContributionOptions {
	readonly service: IKeybindingsResourceService;
	readonly registry?: KeybindingRegistry;
	readonly operatingSystem?: HostOperatingSystem;
}

/**
 * Projects the active keybinding resource into one window registry.
 *
 * Previous registrations remain installed until every new rule validates.
 * A failed replacement disposes its partial registrations and preserves the
 * last complete rule set.
 */
export class KeybindingsResourceContribution extends Disposable {
	private readonly service: IKeybindingsResourceService;
	private readonly registry: KeybindingRegistry;
	private readonly operatingSystem: HostOperatingSystem;
	private readonly registration = this._register(new MutableDisposable<IDisposable>());

	constructor(options: KeybindingsResourceContributionOptions) {
		super();
		this.service = options.service;
		this.registry = options.registry ?? KeybindingsRegistry;
		this.operatingSystem = options.operatingSystem ?? environment.os;
		this.reload(this.service.getKeybindings());
		this._register(this.service.onDidChangeKeybindings((bindings) => {
			this.reload(bindings);
		}));
	}

	private reload(bindings: readonly IKeybindingEntry[]): void {
		const registrations: IDisposable[] = [];
		try {
			for (const binding of bindings) {
				const key = operatingSystemKey(binding, this.operatingSystem);
				if (key === null) continue;
				const keybinding = parseKeybinding(key);
				if (!keybinding) {
					throw new Error(`Invalid keybinding resource entry: ${key}`);
				}
				const when = binding.when === undefined
					? undefined
					: parseContextKeyExpression(binding.when);
				registrations.push(binding.command === null
					? this.registry.registerKeybindingBlocker({
						keybinding,
						when,
						source: KeybindingSource.User,
					})
					: this.registry.registerKeybindingRule({
						command: binding.command,
						keybinding,
						when,
						args: binding.args === undefined ? undefined : [binding.args],
						source: KeybindingSource.User,
					}));
			}
		} catch (error) {
			for (const registration of registrations.reverse()) {
				registration.dispose();
			}
			throw error;
		}
		this.registration.value = combineRegistrations(registrations);
	}
}

function operatingSystemKey(
	binding: IKeybindingEntry,
	target: HostOperatingSystem,
): string | null {
	switch (target) {
		case "mac":
			return binding.mac === undefined ? binding.key : binding.mac;
		case "windows":
			return binding.win === undefined ? binding.key : binding.win;
		case "linux":
			return binding.linux === undefined ? binding.key : binding.linux;
		case "unknown":
			return binding.key;
	}
}

function combineRegistrations(
	registrations: readonly IDisposable[],
): IDisposable {
	return combinedDisposable(...registrations);
}
