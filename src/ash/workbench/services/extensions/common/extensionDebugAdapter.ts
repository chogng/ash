import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ExtensionDebugAdapterContribution } from "./extensionManifest.js";

export interface ExtensionDebugAdapterDefinition extends ExtensionDebugAdapterContribution {
	readonly extensionId: string;
}

/** Read-only debug-adapter lookup exposed to Workbench consumers. */
export interface ExtensionDebugAdapterSource {
	readonly definitions: readonly ExtensionDebugAdapterDefinition[];
	readonly onDidChange: Event<readonly ExtensionDebugAdapterDefinition[]>;
	get(type: string): ExtensionDebugAdapterDefinition | undefined;
}

/** Immutable declarative adapter catalog rebuilt with each extension generation. */
export class ExtensionDebugAdapterRegistry extends Disposable implements ExtensionDebugAdapterSource {
	private readonly changeEmitter = this._register(new Emitter<readonly ExtensionDebugAdapterDefinition[]>());
	private definitionsValue: readonly ExtensionDebugAdapterDefinition[] = Object.freeze([]);
	readonly onDidChange: Event<readonly ExtensionDebugAdapterDefinition[]> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.definitionsValue = Object.freeze([]);
		}));
	}

	get definitions(): readonly ExtensionDebugAdapterDefinition[] { return this.definitionsValue; }
	get(type: string): ExtensionDebugAdapterDefinition | undefined { return this.isDisposed ? undefined : this.definitionsValue.find(definition => definition.type === type); }

	replace(definitions: readonly ExtensionDebugAdapterDefinition[]): void {
		this.assertNotDisposed();
		const next = validateExtensionDebugAdapterDefinitions(definitions);
		if (JSON.stringify(next) === JSON.stringify(this.definitionsValue)) return;
		this.definitionsValue = next;
		this.changeEmitter.fire(next);
	}

}

/** Validates one complete extension generation without mutating the live registry. */
export function validateExtensionDebugAdapterDefinitions(definitions: readonly ExtensionDebugAdapterDefinition[]): readonly ExtensionDebugAdapterDefinition[] {
	const byType = new Map<string, ExtensionDebugAdapterDefinition>();
	for (const definition of definitions) {
		const previous = byType.get(definition.type);
		if (previous) throw new Error(`Debug adapter type '${definition.type}' is contributed by both '${previous.extensionId}' and '${definition.extensionId}'`);
		byType.set(definition.type, Object.freeze({ ...definition, arguments: Object.freeze([...definition.arguments]) }));
	}
	return Object.freeze([...byType.values()].sort((left, right) => left.type.localeCompare(right.type)));
}
