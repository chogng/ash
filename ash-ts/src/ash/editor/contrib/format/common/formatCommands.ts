import { raceCancellationError } from '../../../../base/common/async.js';
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type Position } from "../../../common/core/position.js";
import { type Range } from "../../../common/core/range.js";

import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFeatureRequest } from "../../../common/languages/languageFeatureRequest.js";
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type URI } from "../../../../base/common/uri.js";
import { type TextEdit } from '../../../common/languages.js';

export interface LanguageFormattingOptions {
	readonly tabSize: number;
	readonly insertSpaces: boolean;
	readonly trimTrailingWhitespace?: boolean;
}

export interface LanguageFormattingRequest extends LanguageFeatureRequest {
	readonly resource?: URI;
	readonly range?: Range;
	readonly options: LanguageFormattingOptions;
	readonly position?: Position;
	readonly ch?: string;
}

export interface LanguageFormattingProvider {
	provideDocumentFormattingEdits?(request: LanguageFormattingRequest, signal: AbortSignal): readonly TextEdit[] | Promise<readonly TextEdit[]>;
	provideRangeFormattingEdits?(request: LanguageFormattingRequest, signal: AbortSignal): readonly TextEdit[] | Promise<readonly TextEdit[]>;
	provideOnTypeFormattingEdits?(request: LanguageFormattingRequest, signal: AbortSignal): readonly TextEdit[] | Promise<readonly TextEdit[]>;
}

/** Owns formatting provider dispatch; edit validation/application stays in TextModel and cursor. */
export class FormatService extends Disposable {
	constructor(
		private readonly model: TextModel,
		private readonly documentFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>,
		private readonly documentRangeFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>,
		private readonly onTypeFormattingEditProvider: LanguageFeatureRegistry<LanguageFormattingProvider>,
		private readonly resource?: URI,
	) {
		super();
	}

	provideDocumentFormattingEdits(languageId: string, options: LanguageFormattingOptions, signal?: AbortSignal): Promise<readonly TextEdit[]> {
		return this.provide(this.documentFormattingEditProvider, languageId, { options }, "provideDocumentFormattingEdits", signal);
	}

	provideRangeFormattingEdits(languageId: string, range: Range, options: LanguageFormattingOptions, signal?: AbortSignal): Promise<readonly TextEdit[]> {
		return this.provide(this.documentRangeFormattingEditProvider, languageId, { range, options }, "provideRangeFormattingEdits", signal);
	}

	provideOnTypeFormattingEdits(languageId: string, position: Position, ch: string, options: LanguageFormattingOptions, signal?: AbortSignal): Promise<readonly TextEdit[]> {
		return this.provide(this.onTypeFormattingEditProvider, languageId, { position, ch, options }, "provideOnTypeFormattingEdits", signal);
	}

	private async provide(
		providers: LanguageFeatureRegistry<LanguageFormattingProvider>,
		languageId: string,
		fields: Partial<LanguageFormattingRequest>,
		method: "provideDocumentFormattingEdits" | "provideRangeFormattingEdits" | "provideOnTypeFormattingEdits",
		signal = new AbortController().signal,
	): Promise<readonly TextEdit[]> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), ...(this.resource ? { resource: this.resource } : {}), ...fields } as LanguageFormattingRequest;
		for (const provider of providers.ordered(this.model)) {
			const provide = provider[method];
			if (this.isDisposed || !isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (!provide) continue;
			const edits = await raceCancellationError(Promise.resolve(provide.call(provider, request, signal)), signal);
			if (this.isDisposed || !isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (edits.length > 0) return Object.freeze([...edits]);
		}
		return Object.freeze([]);
	}
}
