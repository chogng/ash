import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { LanguageFeatureRegistry } from '../../languageFeatureRegistry.js';
import { LanguageRequestCoordinator, type LanguageRequestOptions, type LanguageRequestOutcome, type LanguageWorker, type LanguageWorkerRequest } from '../../languages/languageRequestCoordinator.js';
import { LanguageResultAcceptance } from '../../languages/languageResultStore.js';
import { type LanguageSemanticTokensProvider } from '../../languages.js';
import { type SemanticTokenModelSource, type SemanticTokenStylingResolver } from '../../tokens/languageTokens.js';
import { SemanticTokensStylingService } from '../../services/semanticTokensStylingService.js';
import { LanguageTokenLineIndex } from '../../tokens/languageTokenLineIndex.js';
import { createLanguageTokenStore, type LanguageToken, type LanguageTokenResult } from '../../tokens/languageTokens.js';
import { type TextModel } from '../textModel.js';

const SEMANTIC_TOKENS_LANE = 'semanticTokens';
type SemanticTokensLane = typeof SEMANTIC_TOKENS_LANE;

interface SemanticTokensPayload {
	readonly languageId: string;
}

interface SemanticTokensProviderResult {
	readonly tokens: LanguageTokenResult;
	readonly provider?: LanguageSemanticTokensProvider;
}

/** Owns provider requests, version gating, styling, and the semantic line index for one model. */
export class SemanticTokensTextModelPart extends Disposable implements SemanticTokenModelSource {
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	private readonly stylingService = this._register(new SemanticTokensStylingService());
	private readonly tokens: ReturnType<typeof createLanguageTokenStore>;
	private readonly index: LanguageTokenLineIndex;
	private readonly coordinator: LanguageRequestCoordinator<SemanticTokensLane, SemanticTokensPayload, SemanticTokensProviderResult>;
	private providerStyling: SemanticTokenStylingResolver | undefined;
	private requestGeneration = 0;

	readonly onDidChange: LanguageTokenLineIndex['onDidChange'];
	readonly onDidEncounterError: Event<unknown> = this.errorEmitter.event;
	readonly styling: SemanticTokenStylingResolver;

	constructor(readonly textModel: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageSemanticTokensProvider>) {
		super();
		this.tokens = this._register(createLanguageTokenStore(textModel));
		this.index = this._register(new LanguageTokenLineIndex(this.tokens));
		this.onDidChange = this.index.onDidChange;
		this.styling = Object.freeze({
			resolve: (token: LanguageToken) => {
				if (!this.providerStyling) throw new ReferenceError('Semantic token styling has no active provider');
				return this.providerStyling.resolve(token);
			},
		});
		this.coordinator = this._register(new LanguageRequestCoordinator(
			textModel,
			() => new SemanticTokensProviderWorker(textModel, providers),
		));
		this._register(textModel.onDidChangeContent(() => this.schedule()));
		this._register(textModel.onDidChangeLanguage(() => {
			this.coordinator.restartWorker();
			this.clear();
			this.schedule();
		}));
		this._register(providers.onDidChange(() => {
			this.coordinator.restartWorker();
			this.clear();
			this.schedule();
		}));
		this.schedule();
	}

	get lines() {
		return this.index.lines;
	}

	getLineTokens(lineIndex: number) {
		return this.index.getLineTokens(lineIndex);
	}

	requestTokens(languageId: string, options: LanguageRequestOptions = {}): Promise<LanguageRequestOutcome> {
		return this.coordinator.runLatest(SEMANTIC_TOKENS_LANE, Object.freeze({ languageId }), result => {
			this.providerStyling = result.value.provider ? this.stylingService.getStyling(result.value.provider) : undefined;
			const acceptance = this.tokens.accept({ ...result, value: result.value.tokens });
			if (acceptance !== LanguageResultAcceptance.Applied) throw new Error(`Semantic-token result store rejected current result as '${acceptance}'`);
		}, options);
	}

	private clear(): void {
		this.providerStyling = undefined;
		this.tokens.clear();
	}

	private schedule(): void {
		const generation = ++this.requestGeneration;
		if (this.textModel.largeFile.tooLargeForTokenization || this.textModel.largeFile.tooLargeForSynchronization || !this.providers.has(this.textModel)) return;
		const languageId = this.textModel.getLanguageId();
		queueMicrotask(() => void this.request(generation, languageId));
	}

	private async request(generation: number, languageId: string): Promise<void> {
		try {
			if (this.isDisposed || generation !== this.requestGeneration || languageId !== this.textModel.getLanguageId()) return;
			await this.requestTokens(languageId);
		} catch (error) {
			if (this.isDisposed || generation !== this.requestGeneration || isCancellation(error)) return;
			this.errorEmitter.fire(error);
		}
	}
}

class SemanticTokensProviderWorker implements LanguageWorker<SemanticTokensLane, SemanticTokensPayload, SemanticTokensProviderResult> {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageSemanticTokensProvider>) {}

	async run(request: LanguageWorkerRequest<SemanticTokensLane, SemanticTokensPayload>, signal: AbortSignal): Promise<SemanticTokensProviderResult> {
		const providerRequest = Object.freeze({
			requestId: request.requestId,
			model: this.model,
			snapshot: request.snapshot,
			languageId: request.payload.languageId,
			resource: this.model.uri,
		});
		for (const provider of this.providers.ordered(this.model)) {
			signal.throwIfAborted();
			const result = await provider.provideSemanticTokens(providerRequest, signal);
			signal.throwIfAborted();
			if (result) return Object.freeze({ tokens: result, provider });
		}
		return Object.freeze({ tokens: EMPTY_RESULT });
	}

	dispose(): void {}
	[Symbol.dispose](): void { this.dispose(); }
}

const EMPTY_RESULT: LanguageTokenResult = Object.freeze({ tokens: Object.freeze([]) });

function isCancellation(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled' || error.name === 'CancellationError');
}
