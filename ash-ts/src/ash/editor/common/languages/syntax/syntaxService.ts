import { TokenizationRegistry, type IState, type ITokenizationSupport, type TokenizationResult } from '../../languages.js';
import { Range } from '../../core/range.js';
import { type LanguageToken } from '../../tokens/languageTokens.js';
import { Disposable } from "../../../../base/common/lifecycle.js";
import { assertSyntaxRequest, SyntaxProviderRegistry, type SyntaxProviderRequest, type SyntaxRequest, type RegisteredSyntaxProvider } from "./syntaxProviders.js";
import { LanguageRequestCoordinator, type LanguageRequestOptions, type LanguageRequestOutcome, type LanguageWorker, type LanguageWorkerModelSynchronizer, type LanguageWorkerRequest, type LanguageWorkerResultDisposition, type LanguageWorkerResultSettler } from "../languageRequestCoordinator.js";
import { LanguageResultAcceptance } from "../languageResultStore.js";
import { createLanguageDiagnosticSnapshotNormalizer, createLanguageDiagnosticStore, createLanguageTokenSnapshotNormalizer, createLanguageTokenStore, type LanguageDiagnostic, type LanguageDiagnosticResult, type LanguageTokenResult } from "../languageResults.js";
import { type TextModel } from "../../model/textModel.js";
import { type LanguageWorkerDocumentSynchronization, type LanguageWorkerDocumentSynchronizationObserver } from '../../services/textModelSync/textModelSync.protocol.js';

export const SYNTAX_TOKEN_LANE = "tokens";
export const SYNTAX_DIAGNOSTIC_LANE = "diagnostics";
export const SYNTAX_SYNCHRONIZATION = "synchronization";
export type SyntaxLane = typeof SYNTAX_TOKEN_LANE | typeof SYNTAX_DIAGNOSTIC_LANE;
export type SyntaxProviderOperation = SyntaxLane | typeof SYNTAX_SYNCHRONIZATION;
export type SyntaxWorker = LanguageWorker<SyntaxLane, SyntaxRequest, SyntaxResult>;
export type SyntaxWorkerFactory = () => SyntaxWorker;
/** Wraps the default worker without bypassing its provider-module and synchronization lifecycle. */
export type SyntaxWorkerDecorator = (fallback: SyntaxWorker) => SyntaxWorker;
export type SyntaxProviderErrorHandler = (providerId: string, operation: SyntaxProviderOperation, error: unknown) => void;

export interface LanguageTokenSyntaxResult {
	readonly lane: typeof SYNTAX_TOKEN_LANE;
	readonly value: LanguageTokenResult;
}

export interface LanguageDiagnosticSyntaxResult {
	readonly lane: typeof SYNTAX_DIAGNOSTIC_LANE;
	readonly value: LanguageDiagnosticResult;
}

export type SyntaxResult = LanguageTokenSyntaxResult | LanguageDiagnosticSyntaxResult;

export interface SyntaxServiceOptions {
	readonly workerFactory?: SyntaxWorkerFactory;
	/** Per-model runtime adapter applied outside the common language provider registry. */
	readonly workerDecorator?: SyntaxWorkerDecorator;
	readonly onProviderError?: SyntaxProviderErrorHandler;
}

export interface SyntaxRequestOutcomes {
	readonly tokens: LanguageRequestOutcome;
	readonly diagnostics: LanguageRequestOutcome;
}

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

/** Provider host shared by in-process and Worker transports. */
export class SyntaxProviderWorker implements SyntaxWorker, LanguageWorkerDocumentSynchronizationObserver {
	private disposed = false;
	private tokenizationCache: {
		readonly support: ITokenizationSupport;
		readonly lines: readonly { text: string; hasEOL: boolean; state: IState; result: TokenizationResult }[];
	} | undefined;

	constructor(
		private readonly registry: SyntaxProviderRegistry,
		private readonly onProviderError: SyntaxProviderErrorHandler = reportProviderError,
	) {
		if (typeof onProviderError !== "function") {
			throw new TypeError("Syntax provider error handler must be a function");
		}
	}

	async run(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>, signal: AbortSignal): Promise<SyntaxResult> {
		this.ensureAlive();
		signal.throwIfAborted();
		assertSyntaxRequest(request.payload);
		if (request.lane === SYNTAX_TOKEN_LANE) {
			return Object.freeze({
				lane: SYNTAX_TOKEN_LANE,
				value: await this.runTokens(request, signal),
			});
		}
		if (request.lane === SYNTAX_DIAGNOSTIC_LANE) {
			return Object.freeze({
				lane: SYNTAX_DIAGNOSTIC_LANE,
				value: await this.runDiagnostics(request, signal),
			});
		}
		throw new RangeError(`Unknown syntax lane '${request.lane}'`);
	}

	dispose(): void {
		this.disposed = true;
		this.tokenizationCache = undefined;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	synchronizeDocument(synchronization: LanguageWorkerDocumentSynchronization): void {
		this.ensureAlive();
		for (const provider of this.registry.getDocumentSynchronizers()) {
			try {
				provider.synchronizeDocument!(synchronization);
			} catch (error) {
				this.reportProviderError(provider.id, SYNTAX_SYNCHRONIZATION, error);
			}
		}
	}

	private async runTokens(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>, signal: AbortSignal): Promise<LanguageTokenResult> {
		const providers = this.registry.getTokenProviders(request.payload.languageId);
		let support = TokenizationRegistry.get(request.payload.languageId);
		if (providers.some(provider => provider.tokenPriority > 0)) {
			support = null;
		} else if (!support && !TokenizationRegistry.isResolved(request.payload.languageId)) {
			support = await TokenizationRegistry.getOrCreate(request.payload.languageId);
		}
		signal.throwIfAborted();
		if (support) {
			const tokens: LanguageToken[] = [];
			const cached = this.tokenizationCache?.support === support ? this.tokenizationCache.lines : [];
			const next: { text: string; hasEOL: boolean; state: IState; result: TokenizationResult }[] = [];
			let state = support.getInitialState();
			const lines = request.snapshot.getText().split('\n');
			for (let index = 0; index < lines.length; index++) {
				signal.throwIfAborted();
				const line = lines[index]!;
				const hasEOL = index < lines.length - 1;
				const previous = cached[index];
				const result = previous?.text === line && previous.hasEOL === hasEOL && previous.state.equals(state)
					? previous.result
					: support.tokenize(line, hasEOL, state.clone());
				next.push({ text: line, hasEOL, state: state.clone(), result });
				state = result.endState;
				for (let tokenIndex = 0; tokenIndex < result.tokens.length; tokenIndex++) {
					const token = result.tokens[tokenIndex]!;
					const end = result.tokens[tokenIndex + 1]?.offset ?? line.length;
					if (end > token.offset && token.type) tokens.push({
						range: new Range(index + 1, token.offset + 1, index + 1, end + 1),
						tokenType: token.type,
						modifiers: [],
						languageId: token.language,
					});
				}
			}
			const normalized = createLanguageTokenSnapshotNormalizer(request.snapshot)({ tokens });
			this.tokenizationCache = { support, lines: next };
			return normalized;
		}
		if (providers.length === 0) return EMPTY_TOKENS;
		const normalize = createLanguageTokenSnapshotNormalizer(request.snapshot);
		for (const provider of providers) {
			try {
				const value = await provider.provideTokens!(providerRequest(request), signal);
				signal.throwIfAborted();
				if (value !== undefined) return normalize(value);
			} catch (error) {
				if (signal.aborted) throw error;
				this.reportProviderError(provider.id, SYNTAX_TOKEN_LANE, error);
			}
		}
		return EMPTY_TOKENS;
	}

	private async runDiagnostics(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>, signal: AbortSignal): Promise<LanguageDiagnosticResult> {
		const providers = this.registry.getDiagnosticProviders(request.payload.languageId);
		if (providers.length === 0) return EMPTY_DIAGNOSTICS;
		const normalize = createLanguageDiagnosticSnapshotNormalizer(request.snapshot);
		const batches = await Promise.all(providers.map(provider => this.runDiagnosticProvider(provider, request, signal, normalize)));
		signal.throwIfAborted();
		const diagnostics: LanguageDiagnostic[] = [];
		for (const batch of batches) diagnostics.push(...(batch?.diagnostics ?? []));
		return normalize({ diagnostics });
	}

	private async runDiagnosticProvider(
		provider: RegisteredSyntaxProvider,
		request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>,
		signal: AbortSignal,
		normalize: (value: LanguageDiagnosticResult) => LanguageDiagnosticResult,
	): Promise<LanguageDiagnosticResult | undefined> {
		try {
			const value = await provider.provideDiagnostics!(providerRequest(request), signal);
			signal.throwIfAborted();
			return value === undefined ? undefined : normalize(value);
		} catch (error) {
			if (signal.aborted) throw error;
			this.reportProviderError(provider.id, SYNTAX_DIAGNOSTIC_LANE, error);
			return undefined;
		}
	}

	private reportProviderError(providerId: string, operation: SyntaxProviderOperation, error: unknown): void {
		try {
			this.onProviderError(providerId, operation, error);
		} catch (reportingError) {
			reportProviderError(providerId, operation, new AggregateError([error, reportingError], "Syntax and error reporting both failed"));
		}
	}

	private ensureAlive(): void {
		if (this.disposed) {
			throw new ReferenceError("SyntaxProviderWorker is already disposed");
		}
	}
}

const EMPTY_TOKENS: LanguageTokenResult = Object.freeze({ tokens: Object.freeze([]) });
const EMPTY_DIAGNOSTICS: LanguageDiagnosticResult = Object.freeze({ diagnostics: Object.freeze([]) });

function syntaxRequest(languageId: string): SyntaxRequest {
	const request = Object.freeze({ languageId });
	assertSyntaxRequest(request);
	return request;
}

function providerRequest(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>): SyntaxProviderRequest {
	return Object.freeze({
		requestId: request.requestId,
		snapshot: request.snapshot,
		languageId: request.payload.languageId,
	});
}

function assertApplied(acceptance: LanguageResultAcceptance, lane: SyntaxLane): void {
	if (acceptance !== LanguageResultAcceptance.Applied) {
		throw new Error(`Language ${lane} store rejected current result as '${acceptance}'`);
	}
}

function reportProviderError(providerId: string, operation: SyntaxProviderOperation, error: unknown): void {
	console.error(`Syntax provider '${providerId}' failed in '${operation}'`, error);
}
