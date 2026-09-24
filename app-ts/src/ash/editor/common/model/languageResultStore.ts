import { type TextModel } from './textModel.js';
import { type LanguageDiagnosticResult, normalizeLanguageDiagnosticResult } from '../languages.js';
import { Range } from '../core/range.js';
import { type VersionedLanguageResult } from './languageRequestCoordinator.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isPositiveSafeInteger } from '../../../base/common/numbers.js';

export function createLanguageDiagnosticStore(model: TextModel): VersionedLanguageResultStore<LanguageDiagnosticResult> {
	return new VersionedLanguageResultStore(model, (value, currentModel) => normalizeLanguageDiagnosticResult(
		value,
		range => assertDiagnosticModelRange(currentModel, range, "Language diagnostic"),
	));
}

function assertDiagnosticModelRange(model: TextModel, range: Range, owner: string): void {
	if (!(range instanceof Range)) throw new TypeError(`${owner} range must be a Range`);
	model.offsetAt(range.getStartPosition());
	model.offsetAt(range.getEndPosition());
}

/** The outcome of offering one versioned result to a result store. */
export enum LanguageResultAcceptance {
	Applied = "applied",
	StaleVersion = "staleVersion",
	SupersededRequest = "supersededRequest",
	DuplicateRequest = "duplicateRequest",
	ModelUnavailable = "modelUnavailable",
}

export enum LanguageResultStoreChangeReason {
	Result = "result",
	ModelChanged = "modelChanged",
	Cleared = "cleared",
}

export interface LanguageResultStoreUpdate<TResult> {
	readonly reason: LanguageResultStoreChangeReason.Result;
	readonly modelVersion: number;
	readonly result: VersionedLanguageResult<TResult>;
}

export interface LanguageResultStoreClear {
	readonly reason: LanguageResultStoreChangeReason.ModelChanged | LanguageResultStoreChangeReason.Cleared;
	readonly modelVersion: number;
	readonly result: undefined;
}

export type LanguageResultStoreChange<TResult> = LanguageResultStoreUpdate<TResult> | LanguageResultStoreClear;

/**
 * Validates and captures caller-owned worker data.
 *
 * Implementations must return an immutable value and must not retain mutable
 * aliases that can change after the result is accepted.
 */
export type LanguageResultNormalizer<TResult> = (value: TResult, model: TextModel) => TResult;

/**
 * Holds the latest accepted result from one monotonic request-ID domain.
 *
 * The store observes but does not own its text model. Any model transaction
 * clears the result instead of mapping stale language ranges through edits.
 */
export class VersionedLanguageResultStore<TResult> extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<LanguageResultStoreChange<TResult>>());
	private currentResult: VersionedLanguageResult<TResult> | undefined;
	private latestAcceptedRequestId = 0;
	private normalizing = false;

	readonly onDidChange: Event<LanguageResultStoreChange<TResult>> = this.changeEmitter.event;

	constructor(
		private readonly model: TextModel,
		private readonly normalize: LanguageResultNormalizer<TResult>,
	) {
		super();
		if (typeof normalize !== "function") {
			this.dispose();
			throw new TypeError("Language result normalizer must be a function");
		}
		this._register(model.onDidChangeContent(() => this.acceptModelChange()));
		this._register(toDisposable(() => {
			this.currentResult = undefined;
		}));
	}

	get textModel(): TextModel {
		this.assertNotDisposed();
		return this.model;
	}

	get result(): VersionedLanguageResult<TResult> | undefined {
		this.assertNotDisposed();
		if (this.readModelVersion() === undefined) {
			this.currentResult = undefined;
			return undefined;
		}
		return this.currentResult;
	}

	accept(result: VersionedLanguageResult<TResult>): LanguageResultAcceptance {
		this.assertNotDisposed();
		assertResultEnvelope(result);
		if (result.textModel !== this.model) {
			throw new TypeError("Language result store and result must share one text model");
		}
		const currentModelVersion = this.readModelVersion();
		if (currentModelVersion === undefined) {
			return LanguageResultAcceptance.ModelUnavailable;
		}
		if (result.modelVersion !== currentModelVersion) {
			return LanguageResultAcceptance.StaleVersion;
		}
		const requestAcceptance = this.classifyRequest(result);
		if (requestAcceptance !== undefined) return requestAcceptance;
		if (this.normalizing) {
			throw new Error("Language result normalization must not be reentrant");
		}

		let value: TResult;
		this.normalizing = true;
		try {
			value = this.normalize(result.value, this.model);
		} finally {
			this.normalizing = false;
		}
		const versionAfterNormalization = this.readModelVersion();
		if (versionAfterNormalization === undefined) {
			return LanguageResultAcceptance.ModelUnavailable;
		}
		if (versionAfterNormalization !== result.modelVersion) {
			return LanguageResultAcceptance.StaleVersion;
		}
		const acceptanceAfterNormalization = this.classifyRequest(result);
		if (acceptanceAfterNormalization !== undefined) {
			return acceptanceAfterNormalization;
		}

		const accepted = Object.freeze({
			requestId: result.requestId,
			textModel: this.model,
			modelVersion: result.modelVersion,
			value,
		});
		this.latestAcceptedRequestId = accepted.requestId;
		this.currentResult = accepted;
		this.changeEmitter.fire(Object.freeze({
			reason: LanguageResultStoreChangeReason.Result,
			modelVersion: accepted.modelVersion,
			result: accepted,
		}));
		return LanguageResultAcceptance.Applied;
	}

	clear(): void {
		this.assertNotDisposed();
		if (!this.currentResult) return;
		const modelVersion = this.readModelVersion() ?? this.currentResult.modelVersion;
		this.currentResult = undefined;
		this.changeEmitter.fire(Object.freeze({
			reason: LanguageResultStoreChangeReason.Cleared,
			modelVersion,
			result: undefined,
		}));
	}

	private classifyRequest(result: VersionedLanguageResult<TResult>): LanguageResultAcceptance | undefined {
		if (result.requestId < this.latestAcceptedRequestId) {
			return LanguageResultAcceptance.SupersededRequest;
		}
		if (result.requestId === this.latestAcceptedRequestId) {
			return LanguageResultAcceptance.DuplicateRequest;
		}
		return undefined;
	}

	private acceptModelChange(): void {
		if (!this.currentResult) return;
		this.currentResult = undefined;
		const modelVersion = this.model.version;
		this.changeEmitter.fire(Object.freeze({
			reason: LanguageResultStoreChangeReason.ModelChanged,
			modelVersion,
			result: undefined,
		}));
	}

	private readModelVersion(): number | undefined {
		try {
			return this.model.version;
		} catch (error) {
			if (error instanceof ReferenceError) return undefined;
			throw error;
		}
	}

}

function assertResultEnvelope<TResult>(result: VersionedLanguageResult<TResult>): void {
	if (typeof result !== "object" || result === null) {
		throw new TypeError("Language result must be an object");
	}
	assertPositiveSafeInteger(result.requestId, "requestId");
	assertPositiveSafeInteger(result.modelVersion, "modelVersion");
}

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!isPositiveSafeInteger(value)) {
		throw new RangeError(`Language result ${name} must be a positive safe integer`);
	}
}
