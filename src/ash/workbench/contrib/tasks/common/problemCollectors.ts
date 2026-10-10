import { Emitter } from '../../../../base/common/event.js';
import { TaskQueue } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { MarkerSeverity, type IMarkerService, type MarkerInput } from '../../../../platform/markers/common/markers.js';
import type { ProblemMatcher } from './problemMatcher.js';

interface MatcherState {
	readonly matcher: ProblemMatcher;
	readonly owner: string;
	readonly markers: MarkerInput[];
	active: boolean;
	completed: boolean;
	patternIndex: number;
	fields: Record<string, string>;
	loopFields?: Record<string, string>;
	version: number;
	pending: number;
}

/** Consumes task output in order and publishes diagnostics and background readiness. */
export class WatchingProblemCollector extends Disposable {
	private readonly readyEmitter = this._register(new Emitter<void>());
	private readonly problemsEmitter = this._register(new Emitter<void>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	private readonly searchQueue = new TaskQueue();
	private readonly searchController = new AbortController();
	private readonly resolvedFiles = new Map<string, URI>();
	private searchFailure: unknown;
	private readonly decoder = new TextDecoder();
	private readonly states: MatcherState[];
	private pendingLine = '';
	private _isReady = false;
	public readonly onDidBecomeReady = this.readyEmitter.event;
	public readonly onDidChangeProblems = this.problemsEmitter.event;
	public readonly onDidError = this.errorEmitter.event;

	constructor(matchers: readonly ProblemMatcher[], private readonly root: URI, private readonly markers: IMarkerService, taskId: string, private readonly isOpen: (resource: URI) => boolean, private readonly searchFile?: (file: string, matcher: ProblemMatcher, signal: AbortSignal) => Promise<URI | undefined>) {
		super();
		this.states = matchers.map(matcher => ({ matcher, owner: `tasks:${taskId}:${matcher.owner}`, markers: [], active: matcher.watching?.activeOnStart ?? false, completed: false, patternIndex: 0, fields: {}, version: 0, pending: 0 }));
		for (const state of this.states) {
			markers.remove(state.owner);
		}
	}

	public get isReady(): boolean { return this._isReady; }
	public get hasErrors(): boolean { return this.states.some(state => state.markers.some(marker => marker.severity === MarkerSeverity.Error)); }
	public get hasProblems(): boolean { return this.states.some(state => state.markers.length > 0); }
	public get isWatching(): boolean { return this.states.some(state => state.matcher.watching !== undefined); }
	public get owners(): readonly string[] { return this.states.map(state => state.owner); }
	public get hasPendingResolutions(): boolean { return this.states.some(state => state.pending > 0); }

	public cancelSearch(): void {
		this.searchController.abort();
		this.searchQueue.clearPending();
		this.resolvedFiles.clear();
	}

	public async flush(): Promise<void> {
		await this.searchQueue.scheduleSkipIfCleared(() => undefined);
		if (this.searchFailure !== undefined && !this.searchController.signal.aborted) throw this.searchFailure;
	}

	protected override disposeCore(): void {
		this.cancelSearch();
		super.disposeCore();
	}

	public accept(data: Uint8Array): void {
		this.pendingLine += this.decoder.decode(data, { stream: true });
		this.drainLines();
	}

	public done(): void {
		this.pendingLine += this.decoder.decode();
		this.drainLines();
		if (this.pendingLine) {
			this.processLine(this.pendingLine);
			this.pendingLine = '';
		}
	}

	public processLine(value: string): void {
		// Match complete logical lines: ANSI sequences and UTF-8 may span PTY chunks.
		const line = value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '');
		for (const state of this.states) {
			const watching = state.matcher.watching;
			if (watching?.beginsPattern.regexp.test(line)) {
				this._isReady = false;
				state.active = true;
				state.completed = false;
				state.markers.length = 0;
				state.fields = {};
				state.loopFields = undefined;
				state.patternIndex = 0;
				state.version++;
				state.pending = 0;
				this.resolvedFiles.clear();
				this.updateMarkers(state.owner);
			}
			this.matchLine(state, line);
			if (watching?.endsPattern.regexp.test(line) && state.active) {
				state.active = false;
				state.completed = true;
			}
		}
		this.updateReadiness();
	}

	private updateReadiness(): void {
		const watching = this.states.filter(state => state.matcher.watching);
		if (!this.isDisposed && !this.searchController.signal.aborted && this.searchFailure === undefined && !this._isReady && watching.length > 0 && watching.every(state => state.completed && !state.active && state.pending === 0)) {
			this._isReady = true;
			this.readyEmitter.fire();
		}
	}

	private drainLines(): void {
		let newline: number;
		while ((newline = this.pendingLine.indexOf('\n')) >= 0) {
			const line = this.pendingLine.slice(0, newline).replace(/\r$/, '');
			this.pendingLine = this.pendingLine.slice(newline + 1);
			this.processLine(line);
		}
		// Output remains in the Terminal; diagnostics must not retain an unbounded line.
		if (this.pendingLine.length > 65_536) {
			this.pendingLine = this.pendingLine.slice(-65_536);
		}
	}

	private matchLine(state: MatcherState, line: string): void {
		let pattern = state.matcher.pattern[state.patternIndex]!;
		let match = pattern.regexp.exec(line);
		if (!match && state.patternIndex > 0) {
			state.patternIndex = 0;
			state.fields = {};
			state.loopFields = undefined;
			pattern = state.matcher.pattern[0]!;
			match = pattern.regexp.exec(line);
		}
		if (!match) {
			return;
		}
		// Repeating rows inherit header captures, never optional captures from a prior row.
		if (pattern.loop) {
			state.loopFields ??= { ...state.fields };
			state.fields = { ...state.loopFields };
		}
		for (const key of ['file', 'location', 'line', 'character', 'endLine', 'endCharacter', 'message', 'severity', 'code'] as const) {
			const index = pattern[key];
			if (index !== undefined && match[index] !== undefined) {
				state.fields[key] = match[index]!.trim();
			}
		}
		if (state.patternIndex < state.matcher.pattern.length - 1) {
			state.patternIndex += 1;
			return;
		}
		const marker = this.marker(state);
		if (marker && state.markers.length + state.pending < 5000) {
			if (state.matcher.fileLocation === 'search') this.resolveMarker(state, marker, state.fields.file);
			else this.publishMarker(state, marker);
		}
		if (!pattern.loop) {
			state.patternIndex = 0;
			state.fields = {};
		}
	}

	private publishMarker(state: MatcherState, marker: MarkerInput): void {
		const open = this.isOpen(marker.resource);
		if (state.matcher.applyTo === 'openDocuments' && !open || state.matcher.applyTo === 'closedDocuments' && open) return;
		state.markers.push(marker);
		this.updateMarkers(state.owner);
		this.problemsEmitter.fire();
	}

	private updateMarkers(owner: string): void {
		// Multiple output formats may share one compiler's diagnostic owner.
		const markers = this.states.flatMap(state => state.owner === owner ? state.markers : []).slice(0, 5000);
		if (markers.length) {
			this.markers.set(owner, markers);
		} else {
			this.markers.remove(owner);
		}
	}

	private resolveMarker(state: MatcherState, marker: MarkerInput, file: string): void {
		if (this.searchController.signal.aborted) return;
		const version = state.version;
		const key = JSON.stringify([state.matcher.searchPaths, file]);
		state.pending++;
		void this.searchQueue.scheduleSkipIfCleared(async () => {
			if (this.isDisposed || version !== state.version || this.searchController.signal.aborted) return;
			if (!this.searchFile) throw new Error('Search file location requires a file search owner');
			const resource = this.resolvedFiles.get(key) ?? await this.searchFile(file, state.matcher, this.searchController.signal) ?? marker.resource;
			if (this.isDisposed || version !== state.version || this.searchController.signal.aborted) return;
			this.resolvedFiles.set(key, resource);
			this.publishMarker(state, { ...marker, resource });
		}).catch(error => {
			if (!this.isDisposed && version === state.version && !this.searchController.signal.aborted) {
				this.searchFailure = error;
				this.errorEmitter.fire(error);
			}
		}).finally(() => {
			if (version === state.version) state.pending--;
			this.updateReadiness();
		});
	}

	private marker(state: MatcherState): MarkerInput | undefined {
		const fields = state.fields;
		if (!fields.file || !fields.message) {
			return undefined;
		}
		const absolute = /^[a-z]:[\\/]|^[\\/]/i.test(fields.file);
		const prefix = state.matcher.filePrefix;
		const base = prefix === undefined ? this.root : /^[a-z]:[\\/]|^[\\/]/i.test(prefix) ? this.pathResource(prefix) : URI.joinPath(this.root, prefix);
		const resource = state.matcher.fileLocation === 'absolute' || state.matcher.fileLocation === 'search' || state.matcher.fileLocation === 'autoDetect' && absolute ? this.pathResource(fields.file) : URI.joinPath(base, fields.file.replaceAll('\\', '/'));
		const fileOnly = state.matcher.pattern[0].kind === 'file';
		let line = 1;
		let column = 1;
		let endLine = 1;
		let endColumn = 1;
		if (!fileOnly) {
			if (fields.location ? !/\d/.test(fields.location) : !fields.line) return undefined;
			const location = fields.location ? fields.location.split(',') : undefined;
			const startColumn = location ? location[1] : fields.character || undefined;
			const lastColumn = location ? location.length > 3 ? location[3] : undefined : fields.endCharacter || undefined;
			const lastLine = location ? location.length > 3 ? location[2] : undefined : fields.endLine || undefined;
			// Compiler positions are untrusted strings. Normalize them at this boundary
			// so one malformed diagnostic cannot discard the owner's marker batch.
			const coordinate = (value: string | undefined, fallback = 1): number => {
				const parsed = Number.parseInt(value ?? '');
				return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
			};
			line = coordinate(location?.[0] ?? fields.line);
			column = coordinate(startColumn);
			if (startColumn === undefined) {
				endLine = line;
				endColumn = 2 ** 31 - 1;
			} else if (lastColumn === undefined) {
				endLine = line;
				endColumn = column;
			} else {
				endLine = Math.max(line, coordinate(lastLine, line));
				endColumn = coordinate(lastColumn, column);
				// MarkerService stores ordered ranges, including reversed column captures.
				if (endLine === line && endColumn < column) [column, endColumn] = [endColumn, column];
			}
		}
		const severity = fields.severity?.toLowerCase();
		return {
			resource,
			range: fileOnly ? { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 0 } } : { start: { lineIndex: line - 1, columnIndex: column - 1 }, end: { lineIndex: endLine - 1, columnIndex: endColumn - 1 } },
			message: fields.message,
			severity: severity === 'error' || fields.severity === 'E' ? MarkerSeverity.Error : severity === 'warning' || severity === 'warn' || fields.severity === 'W' ? MarkerSeverity.Warning : severity === 'info' || severity === 'note' || severity === 'hint' || fields.severity === 'I' ? MarkerSeverity.Information : state.matcher.severity,
			source: state.matcher.source,
			code: fields.code || undefined,
		};
	}

	private pathResource(path: string): URI {
		// Absolute fallback interprets a relative filename at the filesystem root,
		// rather than borrowing the task folder when search has no result.
		const absolute = /^[a-z]:[\\/]|^[\\/]/i.test(path) ? path : '/' + path;
		return this.root.scheme === Schemas.file ? URI.file(absolute) : this.root.with({ path: absolute.replaceAll('\\', '/') });
	}
}
