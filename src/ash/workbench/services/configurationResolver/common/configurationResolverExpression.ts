import { localize } from '../../../../nls.js';
import type { ConfiguredInput } from './configurationResolver.js';

export interface Replacement {
	readonly id: string;
	readonly inner: string;
	readonly name: string;
	readonly arg?: string;
}

export interface IResolvedValue {
	readonly value: string | undefined;
	readonly input?: ConfiguredInput;
}

/** Owns the original configuration, variable references and invocation-local resolutions. */
export class ConfigurationResolverExpression<T> {
	public static readonly VARIABLE_LHS = '${';
	private readonly replacements = new Map<string, Replacement>();
	private readonly values = new Map<string, IResolvedValue>();
	private readonly source: T;

	private constructor(source: T) {
		this.source = this.map(source, value => {
			this.collect(value);
			return value;
		}) as T;
	}

	public static parse<T>(object: T): ConfigurationResolverExpression<T> {
		return object instanceof ConfigurationResolverExpression ? object : new ConfigurationResolverExpression(object);
	}

	public *unresolved(): Iterable<Replacement> {
		// Map iteration also visits references introduced by a replacement value.
		for (const [id, replacement] of this.replacements) {
			if (!this.values.has(id)) yield replacement;
		}
	}

	public *resolved(): Iterable<[Replacement, IResolvedValue]> {
		for (const [id, value] of this.values) {
			yield [this.replacements.get(id)!, value];
		}
	}

	public resolve(replacement: Replacement, data: string | IResolvedValue): void {
		if (!this.replacements.has(replacement.id)) return;
		const resolved = Object.freeze(typeof data === 'string' ? { value: data } : { ...data });
		this.values.set(replacement.id, resolved);
		if (resolved.value !== undefined) this.collect(resolved.value);
	}

	public toObject(): T {
		return this.map(this.source, value => this.substitute(value, new Set(), new Map())) as T;
	}

	private collect(value: string): void {
		for (const reference of this.variables(value)) {
			if (this.replacements.has(reference.id)) continue;
			if (this.replacements.size >= 4096) throw expansionLimitError();
			this.replacements.set(reference.id, Object.freeze({ id: reference.id, inner: reference.inner, name: reference.name, ...(reference.arg === undefined ? {} : { arg: reference.arg }) }));
		}
	}

	private *variables(value: string): Iterable<Replacement & { readonly start: number; readonly end: number; }> {
		for (let start = value.indexOf('${'); start >= 0; start = value.indexOf('${', start)) {
			let depth = 1;
			let end = start + 2;
			for (; end < value.length && depth; end++) {
				if (value[end] === '$' && value[end + 1] === '{') { depth++; end++; }
				else if (value[end] === '}') depth--;
			}
			if (depth) return;
			const inner = value.slice(start + 2, end - 1);
			if (inner) {
				const separator = inner.indexOf(':');
				yield Object.freeze({ id: value.slice(start, end), inner, name: separator < 0 ? inner : inner.slice(0, separator), ...(separator < 0 ? {} : { arg: inner.slice(separator + 1) }), start, end });
			}
			start = end;
		}
	}

	private substitute(value: string, trail: ReadonlySet<string>, cache: Map<string, string>): string {
		if (trail.size > 128) throw expansionLimitError();
		let result = '';
		let position = 0;
		for (const reference of this.variables(value)) {
			const replacement = this.values.get(reference.id)?.value;
			// A cyclic reference remains visible instead of repeatedly calling its producer.
			const resolved = replacement === undefined || trail.has(reference.id) ? reference.id : cache.get(reference.id) ?? this.substitute(replacement, new Set([...trail, reference.id]), cache);
			// Cache completed expansions; unresolved cycles depend on the current trail.
			if (!resolved.includes('${')) cache.set(reference.id, resolved);
			if (result.length + reference.start - position + resolved.length > 4 * 1024 * 1024) throw expansionLimitError();
			result += value.slice(position, reference.start) + resolved;
			position = reference.end;
		}
		if (result.length + value.length - position > 4 * 1024 * 1024) throw expansionLimitError();
		return result + value.slice(position);
	}

	private map(value: unknown, transform: (value: string) => string): unknown {
		if (typeof value === 'string') return transform(value);
		if (Array.isArray(value)) return value.map(item => this.map(item, transform));
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [transform(key), this.map(item, transform)]));
		}
		// CustomExecution callbacks retain their owner and callable identity.
		return value;
	}
}

function expansionLimitError(): RangeError {
	return new RangeError(localize('configurationResolver.expansionLimit', 'The configuration variable expansion exceeds the supported limit.'));
}
