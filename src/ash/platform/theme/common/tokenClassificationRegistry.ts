import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';

export interface TokenSelector {
	readonly id: string;
	match(type: string, modifiers: readonly string[], language: string): number;
}

export interface TokenTypeOrModifierContribution {
	readonly id: string;
	readonly description: string;
	readonly superType?: string;
}

export interface TokenStyleData {
	readonly foreground?: string;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
}

export interface TokenStyleDefaults { readonly scopesToProbe: readonly (readonly string[])[]; }
export interface SemanticTokenDefaultRule { readonly selector: TokenSelector; readonly defaults: TokenStyleDefaults; }

/** Owns semantic classifications and their syntax scope mappings, including extension lifetimes. */
export class TokenClassificationRegistry extends Disposable {
	private readonly groups = new Map<symbol, { types: readonly string[]; modifiers: readonly string[]; selectors: readonly TokenSelector[]; }>();
	private readonly types = new Map<string, TokenTypeOrModifierContribution>();
	private readonly modifiers = new Map<string, TokenTypeOrModifierContribution>();
	private readonly defaults = new Map<TokenSelector, TokenStyleDefaults>();
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public revision = 0;

	public registerTokenType(id: string, description: string, superType?: string): void {
		validateId(id);
		if (superType) { validateId(superType); }
		if (this.types.has(id)) { throw new TypeError(`Duplicate semantic token type: ${id}`); }
		let parent = superType;
		const ancestors = new Set([id]);
		while (parent) {
			if (ancestors.has(parent)) { throw new TypeError(`Semantic token inheritance cycle: ${id}`); }
			ancestors.add(parent);
			parent = this.types.get(parent)?.superType;
		}
		this.types.set(id, Object.freeze({ id, description, superType }));
		this.publish();
	}

	public deregisterTokenType(id: string): void { if (this.types.delete(id)) { this.publish(); } }
	public registerTokenModifier(id: string, description: string): void {
		validateId(id);
		if (this.modifiers.has(id)) { throw new TypeError(`Duplicate semantic token modifier: ${id}`); }
		this.modifiers.set(id, Object.freeze({ id, description }));
		this.publish();
	}
	public deregisterTokenModifier(id: string): void { if (this.modifiers.delete(id)) { this.publish(); } }
	public getTokenTypes(): readonly TokenTypeOrModifierContribution[] { return [...this.types.values()]; }
	public getTokenModifiers(): readonly TokenTypeOrModifierContribution[] { return [...this.modifiers.values()]; }
	public parseTokenSelector(value: string, language?: string): TokenSelector {
		if (!/^(?:\*|[\w]+)(?:\.[\w]+)*(?::[\w-]+)?$/u.test(value)) { throw new TypeError(`Invalid semantic selector: ${value}`); }
		const [classification, declaredLanguage] = value.split(':');
		const [expectedType, ...expectedModifiers] = classification!.split('.');
		const expectedLanguage = declaredLanguage ?? language;
		return {
			id: value,
			match: (type, modifiers, modelLanguage): number => {
				if (expectedLanguage && expectedLanguage !== modelLanguage || expectedModifiers.some(modifier => !modifiers.includes(modifier))) { return -1; }
				let depth = 0;
				let current: string | undefined = type;
				const visited = new Set<string>();
				while (expectedType !== '*' && current !== expectedType) {
					if (!current || visited.has(current)) { return -1; }
					visited.add(current);
					current = this.types.get(current)?.superType;
					depth++;
				}
				return (expectedLanguage ? 10_000 : 0) + expectedModifiers.length * 100 + (expectedType === '*' ? 0 : 50 / (depth + 1));
			},
		};
	}
	public registerTokenStyleDefault(selector: TokenSelector, defaults: TokenStyleDefaults): void {
		this.defaults.set(selector, defaults);
		this.publish();
	}
	public deregisterTokenStyleDefault(selector: TokenSelector): void { if (this.defaults.delete(selector)) { this.publish(); } }
	public getTokenStylingDefaultRules(): readonly SemanticTokenDefaultRule[] { return [...this.defaults].map(([selector, defaults]) => ({ selector, defaults })); }
	/** Validate the complete catalog first; replacement and removal publish one revision. */
	public replaceContributions(owner: symbol, types: readonly TokenTypeOrModifierContribution[], modifiers: readonly TokenTypeOrModifierContribution[], scopes: readonly { readonly language?: string; readonly scopes: Readonly<Record<string, readonly string[]>>; }[]): void {
		const previous = this.groups.get(owner);
		if (!previous && !types.length && !modifiers.length && !scopes.length) { return; }
		using validation = new TokenClassificationRegistry();
		for (const type of this.types.values()) { if (!previous?.types.includes(type.id)) { validation.registerTokenType(type.id, type.description, type.superType); } }
		for (const modifier of this.modifiers.values()) { if (!previous?.modifiers.includes(modifier.id)) { validation.registerTokenModifier(modifier.id, modifier.description); } }
		for (const type of types) { validation.registerTokenType(type.id, type.description, type.superType); }
		for (const modifier of modifiers) { validation.registerTokenModifier(modifier.id, modifier.description); }
		for (const type of types) {
			if (type.superType && !validation.types.has(type.superType)) { throw new TypeError(`Unknown semantic super type: ${type.superType}`); }
		}
		const defaults = scopes.flatMap(group => Object.entries(group.scopes).map(([selector, mappings]) => ({
			selector: this.parseTokenSelector(selector, group.language), defaults: { scopesToProbe: mappings.map(scope => scope.split(/\s+/u)) },
		})));
		this.types.clear();
		this.modifiers.clear();
		for (const [id, type] of validation.types) { this.types.set(id, type); }
		for (const [id, modifier] of validation.modifiers) { this.modifiers.set(id, modifier); }
		for (const selector of previous?.selectors ?? []) { this.defaults.delete(selector); }
		for (const rule of defaults) { this.defaults.set(rule.selector, rule.defaults); }
		if (types.length || modifiers.length || defaults.length) { this.groups.set(owner, { types: types.map(type => type.id), modifiers: modifiers.map(modifier => modifier.id), selectors: defaults.map(rule => rule.selector) }); } else { this.groups.delete(owner); }
		this.publish();
	}

	private publish(): void { this.revision++; this.changed.fire(); }
}

function validateId(id: string): void {
	if (!/^[a-zA-Z][\w]*$/u.test(id)) { throw new TypeError(`Invalid semantic classification: ${id}`); }
}

const registry = new TokenClassificationRegistry();
const scopes: Record<string, string> = {
	namespace: 'entity.name.namespace', type: 'entity.name.type', class: 'entity.name.type.class', enum: 'entity.name.type.enum',
	interface: 'entity.name.type.interface', struct: 'entity.name.type.struct', typeParameter: 'entity.name.type.parameter',
	parameter: 'variable.parameter', variable: 'variable.other.readwrite', property: 'variable.other.property', enumMember: 'variable.other.enummember',
	function: 'entity.name.function', method: 'entity.name.function.member', macro: 'entity.name.function.preprocessor', label: 'entity.name.label',
	comment: 'comment', string: 'string', keyword: 'keyword', number: 'constant.numeric', regexp: 'string.regexp', operator: 'keyword.operator', modifier: 'storage.modifier', decorator: 'entity.name.function.decorator', event: 'variable.other.event',
};
for (const [id, scope] of Object.entries(scopes)) {
	registry.registerTokenType(id, id, ['class', 'enum', 'interface', 'struct', 'typeParameter'].includes(id) ? 'type' : undefined);
	registry.registerTokenStyleDefault(registry.parseTokenSelector(id), { scopesToProbe: [[scope]] });
}
for (const id of ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary']) { registry.registerTokenModifier(id, id); }

export function getTokenClassificationRegistry(): TokenClassificationRegistry { return registry; }

for (const type of ['variable', 'property']) { registry.registerTokenStyleDefault(registry.parseTokenSelector(type + '.readonly'), { scopesToProbe: [['variable.other.constant']] }); }
