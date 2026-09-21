import { strict as assert } from "node:assert";
import { test } from "mocha";
import { DisposableStore } from "../../../base/common/lifecycle.js";
import { SyntaxProviderRegistry, type SyntaxProvider } from "../../common/languages/syntax/syntaxProviders.js";
import { SYNTAX_SYNCHRONIZATION, SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, SyntaxProviderWorker, SyntaxService } from "../../common/languages/syntax/syntaxService.js";
import { LanguageRequestCancellationReason, LanguageRequestStatus } from "../../common/languages/languageRequestCoordinator.js";
import { LanguageDiagnosticSeverity, type LanguageDiagnosticResult, type LanguageTokenResult } from "../../common/languages/languageResults.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Syntax service selects one token provider and merges diagnostic providers", async () => {
	using model = new TextModel("value");
	using registry = new SyntaxProviderRegistry();
	let ignoredTokenCalls = 0;
	using first = registry.register(provider("first", {
		tokens: () => tokenResult("variable"),
		diagnostics: () => diagnosticResult("first"),
	}));
	using second = registry.register(provider("second", {
		tokens: () => {
			ignoredTokenCalls += 1;
			return tokenResult("keyword");
		},
		diagnostics: () => diagnosticResult("second"),
	}));
	using service = new SyntaxService(model, registry);

	const outcomes = await service.requestAll("typescript");

	assert.equal(outcomes.tokens.status, LanguageRequestStatus.Applied);
	assert.equal(outcomes.diagnostics.status, LanguageRequestStatus.Applied);
	assert.equal(ignoredTokenCalls, 0);
	assert.deepEqual(service.tokens.result!.value.tokens.map(token => token.tokenType), ["variable"]);
	assert.deepEqual(service.diagnostics.result!.value.diagnostics.map(diagnostic => diagnostic.message), ["first", "second"]);
});

test("Token and diagnostic lanes run concurrently while each lane remains latest-wins", async () => {
	using model = new TextModel("value");
	using registry = new SyntaxProviderRegistry();
	const tokenRuns: Array<Deferred<LanguageTokenResult>> = [];
	const diagnosticRun = new Deferred<LanguageDiagnosticResult>();
	using registration = registry.register(provider("controlled", {
		tokens: (_request, signal) => {
			const run = new Deferred<LanguageTokenResult>();
			signal.addEventListener("abort", () => run.reject(new Error("token cancelled")), { once: true });
			tokenRuns.push(run);
			return run.promise;
		},
		diagnostics: () => diagnosticRun.promise,
	}));
	using service = new SyntaxService(model, registry);

	const firstTokens = service.requestTokens("typescript");
	const diagnostics = service.requestDiagnostics("typescript");
	await turn();
	assert.equal(tokenRuns.length, 1);
	const secondTokens = service.requestTokens("typescript");
	await turn();
	assert.equal(tokenRuns.length, 2);

	tokenRuns[1]!.resolve(tokenResult("keyword"));
	diagnosticRun.resolve(diagnosticResult("healthy"));
	const [firstOutcome, secondOutcome, diagnosticOutcome] = await Promise.all([firstTokens, secondTokens, diagnostics]);

	assert.equal(firstOutcome.status, LanguageRequestStatus.Cancelled);
	assert.equal(firstOutcome.status === LanguageRequestStatus.Cancelled && firstOutcome.reason, LanguageRequestCancellationReason.Superseded);
	assert.equal(secondOutcome.status, LanguageRequestStatus.Applied);
	assert.equal(diagnosticOutcome.status, LanguageRequestStatus.Applied);
	assert.equal(service.tokens.result!.value.tokens[0]!.tokenType, "keyword");
	assert.equal(service.diagnostics.result!.value.diagnostics[0]!.message, "healthy");
});

test("Syntax provider failures are isolated by lane and provider", async () => {
	using model = new TextModel("value");
	using registry = new SyntaxProviderRegistry();
	const errors: Array<{ readonly providerId: string; readonly lane: string; readonly error: unknown }> = [];
	using broken = registry.register(provider("broken", {
		tokens: () => {
			throw new Error("token failed");
		},
		diagnostics: () => {
			throw new Error("diagnostic failed");
		},
	}));
	using healthy = registry.register(provider("healthy", {
		diagnostics: () => diagnosticResult("healthy diagnostic"),
	}));
	using service = new SyntaxService(model, registry, {
		onProviderError: (providerId, lane, error) => errors.push({ providerId, lane, error }),
	});

	const outcomes = await service.requestAll("typescript");

	assert.equal(outcomes.tokens.status, LanguageRequestStatus.Applied);
	assert.deepEqual(service.tokens.result!.value.tokens, []);
	assert.deepEqual(service.diagnostics.result!.value.diagnostics.map(diagnostic => diagnostic.message), ["healthy diagnostic"]);
	assert.deepEqual(errors.map(error => [error.providerId, error.lane]), [
		["broken", SYNTAX_TOKEN_LANE],
		["broken", SYNTAX_DIAGNOSTIC_LANE],
	]);
});

test("Syntax provider synchronization failures do not block healthy request lanes", async () => {
	using model = new TextModel("value");
	using registry = new SyntaxProviderRegistry();
	const errors: Array<{ readonly providerId: string; readonly operation: string }> = [];
	using registration = registry.register({
		id: "sync-failure",
		languageIds: ["typescript"],
		provideDiagnostics: () => diagnosticResult("healthy after sync"),
		synchronizeDocument: () => {
			throw new Error("sync failed");
		},
	});
	using worker = new SyntaxProviderWorker(registry, (providerId, operation) => errors.push({ providerId, operation }));
	const previousVersion = model.version;
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (5) + 1)),
		text: "!",
	}]);
	worker.synchronizeDocument({
		previousVersion,
		modelVersion: model.version,
		eol: model.getEOL() as '\n' | '\r\n',
		changes: [{ rangeOffset: 5, rangeLength: 0, text: "!" }],
		snapshot: model.createVersionedSnapshot(),
	});

	const result = await worker.run({
		requestId: 1,
		lane: SYNTAX_DIAGNOSTIC_LANE,
		payload: { languageId: "typescript" },
		snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);

	assert.deepEqual(errors, [{ providerId: "sync-failure", operation: SYNTAX_SYNCHRONIZATION }]);
	assert.equal(result.lane, SYNTAX_DIAGNOSTIC_LANE);
	assert.deepEqual(result.value.diagnostics.map(diagnostic => diagnostic.message), ["healthy after sync"]);
});

test("Model changes cancel both syntax lanes before either store can publish stale ranges", async () => {
	using model = new TextModel("value");
	using registry = new SyntaxProviderRegistry();
	const started: string[] = [];
	using registration = registry.register(provider("slow", {
		tokens: (_request, signal) => pendingUntilAbort(signal, () => started.push(SYNTAX_TOKEN_LANE)),
		diagnostics: (_request, signal) => pendingUntilAbort(signal, () => started.push(SYNTAX_DIAGNOSTIC_LANE)),
	}));
	using service = new SyntaxService(model, registry);
	const pending = service.requestAll("typescript");
	await turn();
	assert.deepEqual(started, [SYNTAX_TOKEN_LANE, SYNTAX_DIAGNOSTIC_LANE]);

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (5) + 1)),
		text: "!",
	}]);
	const outcomes = await pending;

	assert.equal(outcomes.tokens.status, LanguageRequestStatus.Cancelled);
	assert.equal(outcomes.diagnostics.status, LanguageRequestStatus.Cancelled);
	assert.equal(outcomes.tokens.status === LanguageRequestStatus.Cancelled && outcomes.tokens.reason, LanguageRequestCancellationReason.ModelChanged);
	assert.equal(outcomes.diagnostics.status === LanguageRequestStatus.Cancelled && outcomes.diagnostics.reason, LanguageRequestCancellationReason.ModelChanged);
	assert.equal(service.tokens.result, undefined);
	assert.equal(service.diagnostics.result, undefined);
});

test("An unconfigured syntax service does not invent tokens or diagnostics", async () => {
	using model = new TextModel("const value = 1 + 2;\nif (value] {");
	using registry = new SyntaxProviderRegistry();
	using service = new SyntaxService(model, registry);
	await service.requestAll("typescript");
	assert.deepEqual(service.tokens.result!.value.tokens, []);
	assert.deepEqual(service.diagnostics.result!.value.diagnostics, []);
});

test("Syntax registry validates batches and releases providers independently", () => {
	using registry = new SyntaxProviderRegistry();
	const registration = registry.register(provider("one", {
		tokens: () => tokenResult("variable"),
	}));
	assert.throws(() => registry.register(provider("one", {
		diagnostics: () => diagnosticResult("duplicate"),
	})), /already registered/);
	assert.throws(() => registry.register({
		id: "empty",
		languageIds: ["typescript"],
	}), /must implement/);
	assert.throws(() => registry.registerMany([
		provider("same", { tokens: () => tokenResult("variable") }),
		provider("same", { diagnostics: () => diagnosticResult("same") }),
	]), /already registered/);

	registration.dispose();
	assert.equal(registry.getTokenProvider("typescript"), undefined);
});

test("Syntax registry selects the highest token priority and keeps stable ties", () => {
	using registry = new SyntaxProviderRegistry();
	using registrations = new DisposableStore();
	registrations.add(registry.register({ ...provider("baseline", { tokens: () => tokenResult("variable") }), tokenPriority: -10 }));
	registrations.add(registry.register({ ...provider("preferred", { tokens: () => tokenResult("type") }), tokenPriority: 100 }));
	registrations.add(registry.register({ ...provider("same-priority", { tokens: () => tokenResult("keyword") }), tokenPriority: 100 }));

	assert.equal(registry.getTokenProvider("typescript")?.id, "preferred");
	assert.throws(() => registry.register({ ...provider("unsafe", { diagnostics: () => diagnosticResult("invalid") }), tokenPriority: 1 }), /token priority/);
	assert.throws(() => registry.register({ ...provider("fractional", { tokens: () => tokenResult("variable") }), tokenPriority: 0.5 }), /token priority/);
});

test("Token providers fall through undefined and isolated failures by priority", async () => {
	using model = new TextModel("value");
	using registry = new SyntaxProviderRegistry();
	const calls: string[] = [];
	const errors: string[] = [];
	using registrations = new DisposableStore();
	registrations.add(registry.register({
		...provider("baseline", { tokens: () => {
			calls.push("baseline");
			return tokenResult("variable");
		} }),
		tokenPriority: 0,
	}));
	registrations.add(registry.register({
		...provider("missing", { tokens: () => {
			calls.push("missing");
			return undefined;
		} }),
		tokenPriority: 100,
	}));
	registrations.add(registry.register({
		...provider("broken", { tokens: () => {
			calls.push("broken");
			throw new Error("broken tokens");
		} }),
		tokenPriority: 50,
	}));
	using service = new SyntaxService(model, registry, {
		onProviderError: providerId => errors.push(providerId),
	});

	assert.equal((await service.requestTokens("typescript")).status, LanguageRequestStatus.Applied);
	assert.deepEqual(calls, ["missing", "broken", "baseline"]);
	assert.deepEqual(errors, ["broken"]);
	assert.equal(service.tokens.result!.value.tokens[0]!.tokenType, "variable");
});

function provider(
	id: string,
	capabilities: {
		readonly tokens?: NonNullable<SyntaxProvider["provideTokens"]>;
		readonly diagnostics?: NonNullable<SyntaxProvider["provideDiagnostics"]>;
	},
): SyntaxProvider {
	return {
		id,
		languageIds: ["typescript"],
		...(capabilities.tokens === undefined ? {} : { provideTokens: capabilities.tokens }),
		...(capabilities.diagnostics === undefined ? {} : { provideDiagnostics: capabilities.diagnostics }),
	};
}

function tokenResult(tokenType: string): LanguageTokenResult {
	return {
		tokens: [{
			range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)),
			tokenType,
			modifiers: [],
		}],
	};
}

function diagnosticResult(message: string): LanguageDiagnosticResult {
	return {
		diagnostics: [{
			range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)),
			severity: LanguageDiagnosticSeverity.Warning,
			message,
			source: "test",
		}],
	};
}

function turn(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

function pendingUntilAbort<T>(signal: AbortSignal, onStart: () => void): Promise<T> {
	onStart();
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(new Error("syntax cancelled")), { once: true });
	});
}

class Deferred<T> {
	readonly promise: Promise<T>;
	private readonly resolvePromise: (value: T) => void;
	private readonly rejectPromise: (error: unknown) => void;

	constructor() {
		let resolvePromise!: (value: T) => void;
		let rejectPromise!: (error: unknown) => void;
		this.promise = new Promise<T>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		this.resolvePromise = resolvePromise;
		this.rejectPromise = rejectPromise;
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}

	reject(error: unknown): void {
		this.rejectPromise(error);
	}
}
