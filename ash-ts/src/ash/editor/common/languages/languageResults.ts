import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { type Position } from "../core/position.js";
import { Range } from "../core/range.js";
import { type TextSnapshot } from "../core/textChange.js";
import { VersionedLanguageResultStore } from "./languageResultStore.js";
import { type TextModel } from "../model/textModel.js";

export { attachLanguageTokenResultDelta, getLanguageTokenResultDelta } from '../services/semanticTokensDto.js';
export type { LanguageTokenResultDelta, LanguageTokenResultSplice } from '../services/semanticTokensDto.js';
export { createLanguageTokenSnapshotNormalizer, createLanguageTokenStore } from "../tokens/languageTokens.js";
export type { LanguageToken, LanguageTokenResult } from "../tokens/languageTokens.js";

export enum LanguageDiagnosticSeverity {
	Error = "error",
	Warning = "warning",
	Information = "information",
	Hint = "hint",
}

export type LanguageDiagnosticCode = string | number;

export interface LanguageDiagnostic {
	readonly range: Range;
	readonly severity: LanguageDiagnosticSeverity;
	readonly message: string;
	readonly code?: LanguageDiagnosticCode;
	readonly source?: string;
}

export interface LanguageDiagnosticResult {
	readonly diagnostics: readonly LanguageDiagnostic[];
}

export function createLanguageDiagnosticStore(model: TextModel): VersionedLanguageResultStore<LanguageDiagnosticResult> {
	return new VersionedLanguageResultStore(model, (value, currentModel) => normalizeLanguageDiagnosticResult(
		value,
		range => assertModelRange(currentModel, range, "Language diagnostic"),
	));
}

export function createLanguageDiagnosticSnapshotNormalizer(snapshot: TextSnapshot): (value: LanguageDiagnosticResult) => LanguageDiagnosticResult {
	const lines = snapshot.getText().split("\n");
	return value => normalizeLanguageDiagnosticResult(value, range => assertSnapshotRange(lines, range, "Language diagnostic"));
}

function normalizeLanguageDiagnosticResult(value: LanguageDiagnosticResult, validateRange: (range: Range) => void): LanguageDiagnosticResult {
	if (typeof value !== "object" || value === null || !Array.isArray(value.diagnostics)) {
		throw new TypeError("Language diagnostic result must contain a diagnostics array");
	}
	const diagnostics = value.diagnostics.map(diagnostic => {
		if (typeof diagnostic !== "object" || diagnostic === null) {
			throw new TypeError("Language diagnostic must be an object");
		}
		validateRange(diagnostic.range);
		if (!Object.values(LanguageDiagnosticSeverity).includes(diagnostic.severity)) {
			throw new TypeError("Unknown language diagnostic severity");
		}
		if (typeof diagnostic.message !== "string" || diagnostic.message.trim().length === 0) {
			throw new TypeError("Language diagnostic message must not be empty");
		}
		if (diagnostic.code !== undefined) assertDiagnosticCode(diagnostic.code);
		if (diagnostic.source !== undefined) assertIdentifier(diagnostic.source, "Language diagnostic source");
		return Object.freeze({
			range: diagnostic.range,
			severity: diagnostic.severity,
			message: diagnostic.message,
			...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
			...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
		});
	});
	return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
}

function assertModelRange(model: TextModel, range: Range, owner: string): void {
	if (!(range instanceof Range)) throw new TypeError(`${owner} range must be a Range`);
	model.offsetAt(range.getStartPosition());
	model.offsetAt(range.getEndPosition());
}

function assertSnapshotRange(lines: readonly string[], range: Range, owner: string): void {
	if (!(range instanceof Range)) throw new TypeError(`${owner} range must be a Range`);
	assertSnapshotPosition(lines, range.getStartPosition(), owner);
	assertSnapshotPosition(lines, range.getEndPosition(), owner);
}

function assertSnapshotPosition(lines: readonly string[], position: Position, owner: string): void {
	if (position.lineNumber < 1 || position.lineNumber > lines.length || position.column < 1 || position.column > lines[position.lineNumber - 1]!.length + 1) {
		throw new RangeError(`${owner} range is outside its snapshot`);
	}
}

function assertIdentifier(value: unknown, owner: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		throw new TypeError(`${owner} must be a non-empty trimmed string`);
	}
}

function assertDiagnosticCode(code: LanguageDiagnosticCode): void {
	if (typeof code === "string") {
		assertIdentifier(code, "Language diagnostic code");
		return;
	}
	if (typeof code !== "number" || !Number.isFinite(code)) {
		throw new TypeError("Language diagnostic code must be a finite number or non-empty string");
	}
}

/** Current diagnostics; revision `0` is reserved for unopened workspace resources. */
export interface LanguageDiagnosticSnapshot {
	readonly resource: URI;
	readonly revision: number;
	readonly diagnostics: readonly LanguageDiagnostic[];
}

/** Read-only diagnostic source consumed by editor presentation. */
export interface LanguageDiagnosticsSource {
	readonly onDidChangeDiagnostics: Event<URI>;
	getDiagnostics(resource: URI): LanguageDiagnosticSnapshot | undefined;
}

/** One editor-owned diagnostic producer registered with the shared repository. */
export interface LanguageDiagnosticsPublisher extends IDisposable {
	update(revision: number, diagnostics: readonly LanguageDiagnostic[]): void;
}

/** Host boundary for synchronizing and publishing one editor model's diagnostics. */
export interface LanguageDiagnosticsHost extends LanguageDiagnosticsSource {
	acquire(resource: URI, languageId: string, model: TextModel): IDisposable;
	createPublisher(resource: URI): LanguageDiagnosticsPublisher;
}
