import { CancellationTokenSource } from "../../../base/common/cancellation.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { toError } from "../../../base/common/errors.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type TextModel } from "../model/textModel.js";
import { type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "./documentDiffProvider.js";
import { toLineDiff, type LineDiff } from "./lineDiff.js";

export interface DiffModelOptions {
	readonly original: TextModel;
	readonly modified: TextModel;
	readonly diffProvider: IDocumentDiffProvider;
	readonly diffOptions: IDocumentDiffProviderOptions;
}

export interface DiffModelLoadingState {
	readonly kind: "loading";
	readonly originalVersion: number;
	readonly modifiedVersion: number;
}

export interface DiffModelReadyState {
	readonly kind: "ready";
	readonly originalVersion: number;
	readonly modifiedVersion: number;
	readonly quitEarly: boolean;
	readonly diff: LineDiff;
}

export interface DiffModelErrorState {
	readonly kind: "error";
	readonly originalVersion: number;
	readonly modifiedVersion: number;
	readonly error: Error;
}

/** The current version-pinned state of one original/modified text comparison. */
export type DiffModelState = DiffModelLoadingState | DiffModelReadyState | DiffModelErrorState;

/**
 * DOM-free derived model for one pair of caller-owned text documents.
 *
 * It owns request cancellation and result validity, but never either source
 * TextModel or the computation service. A result becomes visible only when
 * both source versions still match the request that produced it.
 */
export class DiffModel extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<DiffModelState>());
	private activeRequest: CancellationTokenSource | undefined;
	private requestGeneration = 0;
	private _state: DiffModelState;
	private diffOptions: IDocumentDiffProviderOptions;

	readonly onDidChange: Event<DiffModelState> = this.changeEmitter.event;

	constructor(private readonly options: DiffModelOptions) {
		super();
		validateOptions(options);
		this.diffOptions = options.diffOptions;
		this._state = Object.freeze({
			kind: "loading",
			originalVersion: options.original.version,
			modifiedVersion: options.modified.version,
		});
		this._register(options.original.onDidChangeContent(() => this.refresh()));
		this._register(options.modified.onDidChangeContent(() => this.refresh()));
		this._register(options.original.onWillDispose(() => this.dispose()));
		this._register(options.modified.onWillDispose(() => this.dispose()));
		this._register(options.diffProvider.onDidChange(() => this.refresh()));
		this._register(toDisposable(() => {
			this.activeRequest?.dispose(true);
			this.activeRequest = undefined;
		}));
		this.refresh();
	}

	get original(): TextModel {
		return this.options.original;
	}

	get modified(): TextModel {
		return this.options.modified;
	}

	get state(): DiffModelState {
		return this._state;
	}

	get diff(): LineDiff | undefined {
		return this._state.kind === "ready" ? this._state.diff : undefined;
	}

	updateOptions(options: IDocumentDiffProviderOptions): void {
		if (this.diffOptions.ignoreTrimWhitespace === options.ignoreTrimWhitespace
			&& this.diffOptions.maxComputationTimeMs === options.maxComputationTimeMs
			&& this.diffOptions.computeMoves === options.computeMoves
			&& this.diffOptions.extendToSubwords === options.extendToSubwords) return;
		this.diffOptions = options;
		this.refresh();
	}

	/** Starts a fresh computation for the current source-model versions. */
	refresh(): void {
		if (this.isDisposed) return;
		const originalVersion = this.original.getVersionId();
		const modifiedVersion = this.modified.getVersionId();
		this.activeRequest?.dispose(true);
		const source = new CancellationTokenSource();
		this.activeRequest = source;
		const generation = ++this.requestGeneration;
		this.setState(Object.freeze({
			kind: "loading",
			originalVersion,
			modifiedVersion,
		}));
		void this.compute(generation, source, originalVersion, modifiedVersion);
	}

	private async compute(generation: number, source: CancellationTokenSource, originalVersion: number, modifiedVersion: number): Promise<void> {
		try {
			const result = await this.options.diffProvider.computeDiff(
				this.original,
				this.modified,
				this.diffOptions,
				source.token,
			);
			if (!this.isCurrentRequest(generation, source, originalVersion, modifiedVersion)) return;
			const diff = toLineDiff(result, this.original.lineCount, this.modified.lineCount);
			source.dispose();
			this.activeRequest = undefined;
			this.setState(Object.freeze({
				kind: "ready",
				originalVersion,
				modifiedVersion,
				quitEarly: result.quitEarly,
				diff,
			}));
		} catch (error) {
			if (source.token.isCancellationRequested || !this.isCurrentRequest(generation, source, originalVersion, modifiedVersion)) return;
			source.dispose();
			this.activeRequest = undefined;
			this.setState(Object.freeze({
				kind: "error",
				originalVersion,
				modifiedVersion,
				error: toError(error),
			}));
		}
	}

	private isCurrentRequest(generation: number, source: CancellationTokenSource, originalVersion: number, modifiedVersion: number): boolean {
		return !this.isDisposed &&
			this.requestGeneration === generation &&
			this.activeRequest === source &&
			this.original.getVersionId() === originalVersion &&
			this.modified.getVersionId() === modifiedVersion;
	}

	private setState(state: DiffModelState): void {
		this._state = state;
		this.changeEmitter.fire(state);
	}
}

function validateOptions(options: DiffModelOptions): void {
	if (!options || typeof options !== "object" || !options.original || !options.modified) {
		throw new TypeError("Diff model requires original and modified text models");
	}
	if (!options.diffProvider || typeof options.diffProvider.computeDiff !== "function") {
		throw new TypeError("Diff model requires a document diff provider");
	}
}
