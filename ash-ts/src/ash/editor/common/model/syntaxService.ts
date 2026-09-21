import { type SyntaxRequest, SYNTAX_TOKEN_LANE, SYNTAX_DIAGNOSTIC_LANE, type SyntaxLane, type SyntaxResult, type SyntaxServiceOptions, type SyntaxRequestOutcomes, TokenizationRegistry, type SyntaxWorker, assertSyntaxRequest } from '../languages.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { SyntaxProviderRegistry } from '../languageFeatureRegistry.js';
import { LanguageRequestCoordinator, type LanguageRequestOptions, type LanguageRequestOutcome, type LanguageWorkerModelSynchronizer, type LanguageWorkerRequest, type LanguageWorkerResultDisposition, type LanguageWorkerResultSettler } from './languageRequestCoordinator.js';
import { createLanguageDiagnosticStore, LanguageResultAcceptance } from './languageResultStore.js';
import { createLanguageTokenStore } from '../tokens/languageTokens.js';
import { type TextModel } from './textModel.js';
import { SyntaxProviderWorker } from '../services/editorWebWorker.js';

/** Runs token and diagnostic lanes over one reusable snapshot worker. */
export class SyntaxService extends Disposable {
	readonly tokens: ReturnType<typeof createLanguageTokenStore>;
	readonly diagnostics: ReturnType<typeof createLanguageDiagnosticStore>;
	private readonly coordinator: LanguageRequestCoordinator<SyntaxLane, SyntaxRequest, SyntaxResult>;

	constructor(
		model: TextModel,
		registry: SyntaxProviderRegistry,
		options: SyntaxServiceOptions = {},
	) {
		super();
		if (!(registry instanceof SyntaxProviderRegistry)) {
			this.dispose();
			throw new TypeError("Syntax service requires a provider registry");
		}
		if (options.workerFactory !== undefined && typeof options.workerFactory !== "function") {
			this.dispose();
			throw new TypeError("Syntax worker factory must be a function");
		}
		if (options.workerDecorator !== undefined && typeof options.workerDecorator !== "function") {
			this.dispose();
			throw new TypeError("Syntax worker decorator must be a function");
		}
		if (options.onProviderError !== undefined && typeof options.onProviderError !== "function") {
			this.dispose();
			throw new TypeError("Syntax provider error handler must be a function");
		}
		if (options.workerFactory && options.onProviderError) {
			this.dispose();
			throw new TypeError("A custom syntax worker owns its provider error policy");
		}
		this.tokens = this._register(createLanguageTokenStore(model));
		this.diagnostics = this._register(createLanguageDiagnosticStore(model));
		const createFallbackWorker = options.workerFactory
			? () => new SyntaxProviderOverlayWorker(registry, options.workerFactory!())
			: () => new SyntaxProviderWorker(registry, options.onProviderError);
		const workerDecorator = options.workerDecorator;
		const createWorker = workerDecorator
			? () => workerDecorator(createFallbackWorker())
			: createFallbackWorker;
		this.coordinator = this._register(new LanguageRequestCoordinator(
			model,
			createWorker,
		));
	}

	requestTokens(languageId: string, options: LanguageRequestOptions = {}): Promise<LanguageRequestOutcome> {
		const request = syntaxRequest(languageId);
		return this.coordinator.runLatest(SYNTAX_TOKEN_LANE, request, result => {
			if (result.value.lane !== SYNTAX_TOKEN_LANE) {
				throw new TypeError(`Token lane received '${result.value.lane}'`);
			}
			const acceptance = this.tokens.accept(Object.freeze({
				...result,
				value: result.value.value,
			}));
			assertApplied(acceptance, SYNTAX_TOKEN_LANE);
		}, options);
	}

	requestDiagnostics(languageId: string, options: LanguageRequestOptions = {}): Promise<LanguageRequestOutcome> {
		const request = syntaxRequest(languageId);
		return this.coordinator.runLatest(SYNTAX_DIAGNOSTIC_LANE, request, result => {
			if (result.value.lane !== SYNTAX_DIAGNOSTIC_LANE) {
				throw new TypeError(`Diagnostic lane received '${result.value.lane}'`);
			}
			const acceptance = this.diagnostics.accept(Object.freeze({
				...result,
				value: result.value.value,
			}));
			assertApplied(acceptance, SYNTAX_DIAGNOSTIC_LANE);
		}, options);
	}

	async requestAll(languageId: string, options: LanguageRequestOptions = {}): Promise<SyntaxRequestOutcomes> {
		const [tokens, diagnostics] = await Promise.all([
			this.requestTokens(languageId, options),
			this.requestDiagnostics(languageId, options),
		]);
		return Object.freeze({ tokens, diagnostics });
	}

	restartWorker(): void {
		this.coordinator.restartWorker();
	}
}

/** Gives explicitly prioritized renderer providers precedence over a host Worker. */
class SyntaxProviderOverlayWorker implements SyntaxWorker, LanguageWorkerModelSynchronizer, LanguageWorkerResultSettler {
	private readonly providers: SyntaxProviderWorker;

	constructor(private readonly registry: SyntaxProviderRegistry, private readonly fallback: SyntaxWorker) {
		this.providers = new SyntaxProviderWorker(registry);
	}

	run(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>, signal: AbortSignal): Promise<SyntaxResult> {
		const languageId = request.payload.languageId;
		const preferred = request.lane === SYNTAX_TOKEN_LANE
			? TokenizationRegistry.get(languageId) !== null || !TokenizationRegistry.isResolved(languageId) || this.registry.getTokenProviders(languageId).some(provider => provider.tokenPriority > 0)
			: this.registry.getDiagnosticProviders(languageId).some(provider => provider.diagnosticPriority > 0);
		return preferred ? this.providers.run(request, signal) : this.fallback.run(request, signal);
	}

	synchronizeModel(change: Parameters<LanguageWorkerModelSynchronizer["synchronizeModel"]>[0]): void {
		const synchronizer = this.fallback as Partial<LanguageWorkerModelSynchronizer>;
		synchronizer.synchronizeModel?.(change);
	}

	settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void {
		const settler = this.fallback as Partial<LanguageWorkerResultSettler>;
		settler.settleResult?.(requestId, disposition);
	}

	dispose(): void {
		this.providers.dispose();
		this.fallback.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function syntaxRequest(languageId: string): SyntaxRequest {
	const request = Object.freeze({ languageId });
	assertSyntaxRequest(request);
	return request;
}

function assertApplied(acceptance: LanguageResultAcceptance, lane: SyntaxLane): void {
	if (acceptance !== LanguageResultAcceptance.Applied) {
		throw new Error(`Language ${lane} store rejected current result as '${acceptance}'`);
	}
}
