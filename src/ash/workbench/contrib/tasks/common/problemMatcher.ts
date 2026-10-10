import { localize } from '../../../../nls.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';

export interface ProblemMatcherContributions {
	readonly matchers: readonly unknown[];
	readonly patterns: readonly unknown[];
}

export interface ProblemMatcherRegistration extends IDisposable {
	readonly contributions: ProblemMatcherContributions;
	replace(contributions: ProblemMatcherContributions): void;
}

interface ProblemMatcherCatalog {
	readonly matchers: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	readonly patterns: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

const contributionOwners = new Map<object, ProblemMatcherContributions>();
let catalog: ProblemMatcherCatalog = { matchers: new Map(), patterns: new Map() };

/** The declarative extension owner replaces one complete contribution set atomically. */
export function registerProblemMatcherContributions(initial: ProblemMatcherContributions): ProblemMatcherRegistration {
	const owner = {};
	let disposed = false;
	let current: ProblemMatcherContributions;
	const replace = (supplied: ProblemMatcherContributions): void => {
		if (disposed) throw new ReferenceError(localize('tasks.matcherRegistrationDisposed', 'Problem matcher registration is disposed'));
		const encoded = JSON.stringify(supplied);
		if (encoded.length > 524288) throw new RangeError(localize('tasks.matcherContributionsTooLarge', 'Problem matcher contributions are too large'));
		const normalized = freezeJson(JSON.parse(encoded)) as ProblemMatcherContributions;
		const owners = new Map(contributionOwners);
		owners.set(owner, normalized);
		const next = createCatalog(owners.values());
		// Parsing every reference before publication prevents a partial catalog on failure.
		for (const name of next.matchers.keys()) parseMatcher(name, next);
		for (const pattern of next.patterns.values()) parsePatterns(pattern.patterns ?? pattern);
		contributionOwners.set(owner, normalized);
		catalog = next;
		current = normalized;
	};
	replace(initial);
	const handle = toDisposable(() => {
		disposed = true;
		contributionOwners.delete(owner);
		// Removing an owner must not retain references to its package. Other owners
		// may become unavailable; they are validated again at task dispatch.
		catalog = createCatalog(contributionOwners.values());
	}) as ProblemMatcherRegistration;
	Object.defineProperty(handle, 'contributions', { get: () => current });
	handle.replace = replace;
	return handle;
}

function createCatalog(owners: Iterable<ProblemMatcherContributions>): ProblemMatcherCatalog {
	const matchers = new Map<string, Readonly<Record<string, unknown>>>();
	const patterns = new Map<string, Readonly<Record<string, unknown>>>();
	for (const owner of owners) {
		for (const [values, target] of [[owner.matchers, matchers], [owner.patterns, patterns]] as const) {
			if (!Array.isArray(values) || values.length > 256) throw new TypeError(localize('tasks.matcherContributionArray', 'Problem contributions require arrays of at most 256 entries'));
			for (const value of values) {
				const contribution = record(value, 'Problem contribution');
				const name = text(contribution.name, 'Problem contribution name');
				if (name.length > 128 || name.startsWith('$') || /[\x00-\x1f\x7f]/.test(name)) throw new TypeError(localize('tasks.matcherContributionName', 'Invalid problem contribution name'));
				const reference = `$${name}`;
				if (target.has(reference)) throw new TypeError(localize('tasks.matcherContributionDuplicate', "Problem contribution '{0}' is already registered", name));
				if (target.size >= 2048) throw new RangeError(localize('tasks.matcherContributionLimit', 'Too many problem contributions'));
				target.set(reference, contribution);
			}
		}
	}
	return { matchers, patterns };
}

function freezeJson(value: unknown): unknown {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}

export interface IProblemPattern {
	readonly regexp: RegExp;
	readonly kind?: 'file' | 'location';
	readonly file?: number;
	readonly location?: number;
	readonly line?: number;
	readonly character?: number;
	readonly endLine?: number;
	readonly endCharacter?: number;
	readonly severity?: number;
	readonly code?: number;
	readonly message?: number;
	readonly loop?: boolean;
}

export interface IWatchingPattern {
	readonly regexp: RegExp;
	readonly file?: number;
}

export interface ProblemMatcher {
	readonly owner: string;
	readonly source?: string;
	readonly severity: MarkerSeverity;
	readonly applyTo: 'allDocuments' | 'openDocuments' | 'closedDocuments';
	readonly fileLocation: 'absolute' | 'relative' | 'autoDetect' | 'search';
	readonly filePrefix?: string;
	readonly searchPaths?: { readonly include: readonly string[]; readonly exclude: readonly string[]; };
	readonly pattern: readonly IProblemPattern[];
	readonly watching?: { readonly activeOnStart: boolean; readonly beginsPattern: IWatchingPattern; readonly endsPattern: IWatchingPattern; };
}

/** Validates executable matchers before any task process is created. */
export function parseProblemMatchers(values: readonly unknown[]): readonly ProblemMatcher[] {
	if (values.length > 32) {
		throw new RangeError('A task cannot use more than 32 problem matchers');
	}
	return Object.freeze(values.map(value => parseMatcher(value, catalog)));
}

function matcherReference(name: string, snapshot: ProblemMatcherCatalog, visiting = new Set<string>()): Record<string, unknown> {
	const contributed = snapshot.matchers.get(name);
	if (!contributed) return builtinMatcher(name);
	if (visiting.has(name) || visiting.size >= 64) throw new TypeError(localize('tasks.matcherBaseCycle', "Cyclic problem matcher base '{0}'", name));
	visiting.add(name);
	const base = contributed.base === undefined ? {} : matcherReference(text(contributed.base, 'problemMatcher.base'), snapshot, visiting);
	visiting.delete(name);
	const effective = { ...base, ...contributed };
	delete effective.base;
	return effective;
}

function parseMatcher(value: unknown, snapshot: ProblemMatcherCatalog): ProblemMatcher {
	if (typeof value === 'string') {
		return parseMatcher(matcherReference(value, snapshot), snapshot);
	}
	const input = record(value, 'problemMatcher');
	const base = input.base === undefined ? {} : matcherReference(text(input.base, 'problemMatcher.base'), snapshot);
	const effective = { ...base, ...input };
	let patternValue = effective.pattern;
	if (typeof patternValue === 'string') {
		const contributed = snapshot.patterns.get(patternValue);
		patternValue = contributed ? contributed.patterns ?? contributed : builtinPattern(patternValue);
	}
	const pattern = parsePatterns(patternValue);
	const location = effective.fileLocation ?? 'relative';
	const fileLocation = Array.isArray(location) ? location[0] : location;
	if (fileLocation !== 'relative' && fileLocation !== 'absolute' && fileLocation !== 'autoDetect' && fileLocation !== 'search') {
		throw new TypeError('Unsupported problemMatcher.fileLocation');
	}
	let searchPaths: ProblemMatcher['searchPaths'];
	if (fileLocation === 'search') {
		const supplied = Array.isArray(location) && location[1] !== undefined ? record(location[1], 'problemMatcher.fileLocation.search') : { include: '${workspaceFolder}' };
		if (Object.keys(supplied).some(key => key !== 'include' && key !== 'exclude')) throw new TypeError('Invalid problemMatcher search paths');
		const paths = (value: unknown): readonly string[] => {
			const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
			if (values.length > 64) throw new RangeError('Too many problemMatcher search paths');
			return Object.freeze(values.map(value => text(value, 'problemMatcher search directory')));
		};
		searchPaths = Object.freeze({ include: paths(supplied.include), exclude: paths(supplied.exclude) });
	}
	const applyTo = effective.applyTo ?? 'allDocuments';
	if (applyTo !== 'allDocuments' && applyTo !== 'openDocuments' && applyTo !== 'closedDocuments') {
		throw new TypeError('Invalid problemMatcher.applyTo');
	}
	const background = effective.background ?? effective.watching;
	const watching = background === undefined ? undefined : record(background, 'problemMatcher.background');
	return Object.freeze({
		owner: text(effective.owner ?? 'external', 'problemMatcher.owner'),
		source: effective.source === undefined ? undefined : text(effective.source, 'problemMatcher.source'),
		severity: severity(effective.severity),
		applyTo,
		fileLocation,
		filePrefix: fileLocation !== 'search' && Array.isArray(location) && location[1] !== undefined ? text(location[1], 'problemMatcher.fileLocation') : undefined,
		searchPaths,
		pattern: Object.freeze(pattern),
		watching: watching === undefined ? undefined : Object.freeze({
			activeOnStart: watching.activeOnStart === true,
			beginsPattern: watchPattern(watching.beginsPattern),
			endsPattern: watchPattern(watching.endsPattern),
		}),
	});
}

function parsePatterns(value: unknown): readonly IProblemPattern[] {
	const patterns = Array.isArray(value) ? value : [value];
	if (patterns.length === 0 || patterns.length > 32) throw new TypeError('problemMatcher.pattern must contain 1 to 32 patterns');
	// Array entries combine captures across lines; defaults would manufacture
	// fields that the author deliberately supplied in a different entry.
	const defaults = !Array.isArray(value);
	const parsed = patterns.map((entry, index) => parsePattern(entry, index, patterns.length, defaults));
	const captures = (key: 'file' | 'message' | 'line' | 'location'): boolean => parsed.some(pattern => pattern[key] !== undefined);
	if (!captures('file') || !captures('message') || parsed[0].kind !== 'file' && !captures('line') && !captures('location')) {
		throw new TypeError('Problem patterns require file, message and a line or location unless kind is file');
	}
	return Object.freeze(parsed);
}

function parsePattern(value: unknown, index: number, count: number, defaults: boolean): IProblemPattern {
	const input = record(value, 'problemMatcher.pattern');
	const first = index === 0;
	const last = index === count - 1;
	if (input.loop !== undefined && (typeof input.loop !== 'boolean' || input.loop && !last)) {
		throw new TypeError('Only the last problem pattern may loop');
	}
	if (input.kind !== undefined && input.kind !== 'file' && input.kind !== 'location') {
		throw new TypeError('Invalid problem pattern kind');
	}
	if (input.kind !== undefined && !first) {
		throw new TypeError('Problem pattern kind must be specified in the first entry');
	}
	const defaultCoordinates = defaults && input.location === undefined && input.kind !== 'file';
	return Object.freeze({
		regexp: expression(input.regexp),
		kind: input.kind as 'file' | 'location' | undefined,
		file: group(input.file, defaults ? 1 : undefined),
		location: group(input.location),
		line: group(input.line, defaultCoordinates ? 2 : undefined),
		character: group(input.column, defaultCoordinates ? 3 : undefined),
		endLine: group(input.endLine),
		endCharacter: group(input.endColumn),
		severity: group(input.severity),
		code: group(input.code),
		message: group(input.message, defaults ? 0 : undefined),
		loop: input.loop === true,
	});
}

function watchPattern(value: unknown): IWatchingPattern {
	if (typeof value === 'string') {
		return Object.freeze({ regexp: expression(value) });
	}
	const input = record(value, 'problemMatcher.background pattern');
	return Object.freeze({ regexp: expression(input.regexp), file: group(input.file) });
}

function group(value: unknown, fallback?: number): number | undefined {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 256) {
		throw new TypeError('Problem pattern capture indices must be integers from 0 to 256');
	}
	return value as number;
}

function expression(value: unknown): RegExp {
	const source = text(value, 'Problem pattern regular expression');
	if (source.length > 4096) {
		throw new RangeError('Problem pattern regular expressions cannot exceed 4096 characters');
	}
	return new RegExp(source);
}

function severity(value: unknown): MarkerSeverity {
	if (value === undefined || value === 'error') {
		return MarkerSeverity.Error;
	}
	if (value === 'warning') {
		return MarkerSeverity.Warning;
	}
	if (value === 'info' || value === 'information') {
		return MarkerSeverity.Information;
	}
	throw new TypeError('Invalid problem matcher severity');
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
		throw new TypeError(`${field} must be a nonempty string without NUL`);
	}
	return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function builtinMatcher(name: string): Record<string, unknown> {
	if (name === '$tsc' || name === '$tsc-watch') {
		return {
			owner: 'typescript', source: 'ts', fileLocation: 'relative',
			pattern: { regexp: '^(.+?)\\((\\d+),(\\d+)\\):\\s+(error|warning)\\s+TS(\\d+):\\s+(.*)$', file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
			...(name === '$tsc-watch' ? { background: { activeOnStart: true, beginsPattern: '(?:Starting compilation|File change detected)', endsPattern: '(?:Compilation complete|Found \\d+ errors?\\. Watching for file changes)' } } : {}),
		};
	}
	if (name === '$gcc') {
		return { owner: 'cpp', fileLocation: 'autoDetect', pattern: { regexp: '^(.+?):(\\d+):(\\d+):\\s+(?:fatal )?(error|warning|note):\\s+(.*)$', file: 1, line: 2, column: 3, severity: 4, message: 5 } };
	}
	if (name === '$msCompile') {
		return { owner: 'msCompile', source: 'cpp', fileLocation: 'absolute', pattern: builtinPattern(name) };
	}
	if (name === '$gulp-tsc' || name === '$go') {
		return { owner: name === '$go' ? 'go' : 'typescript', source: name === '$go' ? 'go' : 'ts', fileLocation: 'relative', applyTo: name === '$gulp-tsc' ? 'closedDocuments' : 'allDocuments', pattern: builtinPattern(name) };
	}
	if (name === '$lessCompile' || name === '$jshint' || name === '$jshint-stylish' || name === '$eslint-compact' || name === '$eslint-stylish') {
		const owner = name.slice(1).split('-')[0]!;
		return { owner, source: owner === 'lessCompile' ? 'less' : owner, fileLocation: 'absolute', pattern: builtinPattern(name) };
	}
	throw new TypeError(`Unknown problem matcher '${name}'`);
}

function builtinPattern(name: string): unknown {
	if (name === '$tsc' || name === '$gcc') {
		return builtinMatcher(name).pattern;
	}
	if (name === '$msCompile') {
		return { regexp: '^\\s*(?:\\d+>)?\\s*(.+?)(?:\\((\\d+(?:,\\d+(?:,\\d+,\\d+)?)?)\\))?\\s*:\\s*(?:[^:\\r\\n]*?\\s+)?(fatal +error|error|warning|info)\\s+([^:\\s]*)\\s*:\\s*(.*)$', file: 1, location: 2, severity: 3, code: 4, message: 5 };
	}
	if (name === '$cpp' || name === '$csc' || name === '$vb') {
		const prefix = { '$cpp': 'C', '$csc': 'CS', '$vb': 'BC' }[name];
		return { regexp: `^(.+?)\\((\\d+(?:,\\d+(?:,\\d+,\\d+)?)?)\\):\\s*(error|warning|info)\\s+(${prefix}\\d+)\\s*:\\s*(.*)$`, file: 1, location: 2, severity: 3, code: 4, message: 5 };
	}
	if (name === '$gulp-tsc') {
		return { regexp: '^(.+?)\\((\\d+(?:,\\d+(?:,\\d+,\\d+)?)?)\\):\\s*(\\d+)\\s+(.+)$', file: 1, location: 2, code: 3, message: 4 };
	}
	if (name === '$lessCompile') {
		return [{ regexp: '^\\s*(.+?) in file (.+?) line no\\. (\\d+)\\s*$', file: 2, line: 3, message: 1 }];
	}
	if (name === '$go') {
		return { regexp: '^(?:[^:]+: )?((?:[a-zA-Z]:)?[^:]+):(\\d+)(?::(\\d+))?:\\s*(.+)$', file: 1, line: 2, column: 3, message: 4 };
	}
	if (name === '$jshint') {
		return { regexp: '^(.+?):\\s*line (\\d+),\\s*col (\\d+),\\s*(.+?)(?:\\s+\\(([EWI])(\\d+)\\))?$', file: 1, line: 2, column: 3, message: 4, severity: 5, code: 6 };
	}
	if (name === '$eslint-compact') {
		return { regexp: '^(.+?):\\s*line (\\d+),\\s*col (\\d+),\\s*(Error|Warning|Info) - (.+) \\(([^()]+)\\)$', file: 1, line: 2, column: 3, severity: 4, message: 5, code: 6 };
	}
	if (name === '$jshint-stylish' || name === '$eslint-stylish') {
		return [
			{ regexp: name === '$jshint-stylish' ? '^(\\S.*)$' : '^((?:[a-zA-Z]:)?[./\\\\].*)$', file: 1 },
			name === '$jshint-stylish'
				? { regexp: '^\\s+line (\\d+)\\s+col (\\d+)\\s+(.+?)(?:\\s+\\(([EWI])(\\d+)\\))?$', line: 1, column: 2, message: 3, severity: 4, code: 5, loop: true }
				: { regexp: '^\\s+(\\d+):(\\d+)\\s+(error|warning|info)\\s+(.+?)(?:\\s{2,}(\\S.*))?\\s*$', line: 1, column: 2, severity: 3, message: 4, code: 5, loop: true },
		];
	}
	throw new TypeError(localize('tasks.unknownProblemPattern', "Unknown problem pattern '{0}'", name));
}
