import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { SyntaxProviderRegistry } from '../../common/languageFeatureRegistry.js';
import { type SyntaxProvider, SYNTAX_TOKENIZE_LANE, SYNTAX_SYNCHRONIZATION, SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, LanguageDiagnosticSeverity, type LanguageDiagnosticResult } from '../../common/languages.js';
import { SyntaxProviderWorker } from '../../common/services/editorWebWorker.js';
import { type LanguageTokenResult } from '../../common/tokens/languageTokens.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';
import { TokenizationRegistry, type IState, type ITokenizationSupport } from '../../common/languages.js';

test('Syntax worker reuses unchanged lines until their incoming token state changes', async () => {
	using model = new TextModel('open\nword\nclose\ntail');
	using registry = new SyntaxProviderRegistry();
	using worker = new SyntaxProviderWorker(registry);
	const calls: string[] = [];
	using registration = TokenizationRegistry.register('typescript', statefulSupport(calls));
	await runLane(worker, model, SYNTAX_TOKEN_LANE);
	calls.length = 0;
	await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual(calls, []);

	model.applyEdits([{ range: new Range(2, 1, 2, 5), text: 'text' }]);
	const edited = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual(calls, ['text']);
	assert.deepEqual(edited.value.tokens.map(token => token.tokenType), ['comment', 'comment', 'word', 'word']);

	calls.length = 0;
	model.applyEdits([{ range: new Range(1, 1, 1, 5), text: 'start' }]);
	const changedState = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual(calls, ['start', 'text', 'close']);
	assert.deepEqual(changedState.value.tokens.map(token => token.tokenType), ['word', 'word', 'word', 'word']);
});

test('Syntax worker invalidates cached line endings and replaced tokenization support', async () => {
	using model = new TextModel('word\ntail');
	using registry = new SyntaxProviderRegistry();
	using worker = new SyntaxProviderWorker(registry);
	const calls: string[] = [];
	using registration = TokenizationRegistry.register('typescript', statefulSupport(calls));
	await runLane(worker, model, SYNTAX_TOKEN_LANE);
	calls.length = 0;
	model.applyEdits([{ range: new Range(2, 5, 2, 5), text: '\n' }]);
	await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual(calls, ['tail', '']);

	calls.length = 0;
	using replacement = TokenizationRegistry.register('typescript', statefulSupport(calls));
	await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual(calls, ['word', 'tail', '']);
});

test('Syntax worker retains the last successful token state when tokenization fails', async () => {
	using model = new TextModel('word\ntail');
	using registry = new SyntaxProviderRegistry();
	using worker = new SyntaxProviderWorker(registry);
	const calls: string[] = [];
	using registration = TokenizationRegistry.register('typescript', statefulSupport(calls));
	const original = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	model.applyEdits([{ range: new Range(1, 1, 2, 5), text: 'open\nfail' }]);
	await assert.rejects(runLane(worker, model, SYNTAX_TOKEN_LANE), /Tokenization failed/);
	model.applyEdits([{ range: new Range(1, 1, 2, 5), text: 'word\ntail' }]);
	calls.length = 0;
	const restored = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual({ calls, tokens: restored.value.tokens }, { calls: [], tokens: original.value.tokens });
});

class TokenState implements IState {
	constructor(public inComment = false) {}

	public clone(): TokenState {
		return new TokenState(this.inComment);
	}

	public equals(other: IState): boolean {
		return other instanceof TokenState && other.inComment === this.inComment;
	}
}

function statefulSupport(calls: string[]): ITokenizationSupport {
	return {
		getInitialState: () => new TokenState(),
		tokenize(line, _hasEOL, state) {
			calls.push(line);
			assert.ok(state instanceof TokenState);
			if (line === 'fail') {
				throw new Error('Tokenization failed');
			}
			if (line === 'open' || line === 'close') {
				state.inComment = line === 'open';
			}
			return { tokens: [{ offset: 0, type: state.inComment ? 'comment' : 'word', language: 'typescript' }], endState: state };
		},
	};
}

test("Syntax worker selects one token provider and merges diagnostic providers", async () => {
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
	using worker = new SyntaxProviderWorker(registry);

	const tokens = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	const diagnostics = await runLane(worker, model, SYNTAX_DIAGNOSTIC_LANE);

	assert.equal(ignoredTokenCalls, 0);
	assert.deepEqual(tokens.value.tokens.map(token => token.tokenType), ["variable"]);
	assert.deepEqual(diagnostics.value.diagnostics.map(diagnostic => diagnostic.message), ["first", "second"]);
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
	using worker = new SyntaxProviderWorker(registry, (providerId, lane, error) => errors.push({ providerId, lane, error }));

	const tokens = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	const diagnostics = await runLane(worker, model, SYNTAX_DIAGNOSTIC_LANE);

	assert.deepEqual(tokens.value.tokens, []);
	assert.deepEqual(diagnostics.value.diagnostics.map(diagnostic => diagnostic.message), ["healthy diagnostic"]);
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

test("An unconfigured syntax worker does not invent tokens or diagnostics", async () => {
	using model = new TextModel("const value = 1 + 2;\nif (value] {");
	using registry = new SyntaxProviderRegistry();
	using worker = new SyntaxProviderWorker(registry);
	const tokens = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	const diagnostics = await runLane(worker, model, SYNTAX_DIAGNOSTIC_LANE);
	assert.deepEqual(tokens.value.tokens, []);
	assert.deepEqual(diagnostics.value.diagnostics, []);
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
	using worker = new SyntaxProviderWorker(registry, providerId => errors.push(providerId));

	const tokens = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	assert.deepEqual(calls, ["missing", "broken", "baseline"]);
	assert.deepEqual(errors, ["broken"]);
	assert.equal(tokens.value.tokens[0]!.tokenType, "variable");
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

async function runLane<T extends typeof SYNTAX_TOKEN_LANE | typeof SYNTAX_DIAGNOSTIC_LANE>(worker: SyntaxProviderWorker, model: TextModel, lane: T): Promise<Extract<import('../../common/languages.js').SyntaxResult, { lane: T }>> {
	const result = await worker.run({ requestId: 1, lane, payload: { languageId: 'typescript' }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal);
	assert.equal(result.lane, lane);
	return result as Extract<import('../../common/languages.js').SyntaxResult, { lane: T }>;
}


test('hypothetical tokenization borrows incoming state and cannot replace real cached states', async () => {
	using model = new TextModel('open\nword\nclose\ntail');
	using registry = new SyntaxProviderRegistry();
	using worker = new SyntaxProviderWorker(registry);
	const calls: string[] = [];
	using registration = TokenizationRegistry.register('typescript', statefulSupport(calls));
	const before = await runLane(worker, model, SYNTAX_TOKEN_LANE);
	calls.length = 0;
	const result = await worker.run({ requestId: 2, lane: SYNTAX_TOKENIZE_LANE, snapshot: model.createVersionedSnapshot(), payload: {
		languageId: 'typescript', tokenize: { lineNumber: 2, lines: ['preview', 'close', 'after'] },
	} }, new AbortController().signal);
	assert.equal(result.lane, SYNTAX_TOKENIZE_LANE);
	if (result.lane !== SYNTAX_TOKENIZE_LANE) throw new Error('Wrong lane');
	assert.deepEqual(result.value!.tokens.map(token => [token.range.startLineNumber, token.tokenType]), [[1, 'comment'], [2, 'word'], [3, 'word']]);
	assert.deepEqual(calls, ['preview', 'close', 'after']);
	calls.length = 0;
	assert.deepEqual((await runLane(worker, model, SYNTAX_TOKEN_LANE)).value, before.value);
	assert.deepEqual(calls, []);
});

test('a selected provider without hypothetical tokenization does not borrow another lexer', async () => {
	using model = new TextModel('word');
	using registry = new SyntaxProviderRegistry();
	using tokenizer = TokenizationRegistry.register('typescript', statefulSupport([]));
	using registration = registry.register({ id: 'preferred', languageIds: ['typescript'], tokenPriority: 100, provideTokens: () => ({ tokens: [] }) });
	using worker = new SyntaxProviderWorker(registry);
	const result = await worker.run({ requestId: 1, lane: SYNTAX_TOKENIZE_LANE, snapshot: model.createVersionedSnapshot(), payload: {
		languageId: 'typescript', tokenize: { lineNumber: 1, lines: ['open'] },
	} }, new AbortController().signal);
	assert.deepEqual(result, { lane: SYNTAX_TOKENIZE_LANE, value: null });
});

test('hypothetical tokens retain an embedded language even when it has no styling scope', async () => {
	using model = new TextModel('word');
	using registry = new SyntaxProviderRegistry();
	using registration = TokenizationRegistry.register('typescript', {
		getInitialState: () => new TokenState(),
		tokenize: (_line, _hasEOL, state) => ({ tokens: [{ offset: 0, type: '', language: 'embedded' }], endState: state }),
	});
	using worker = new SyntaxProviderWorker(registry);
	const result = await worker.run({ requestId: 1, lane: SYNTAX_TOKENIZE_LANE, snapshot: model.createVersionedSnapshot(), payload: {
		languageId: 'typescript', tokenize: { lineNumber: 1, lines: ['begin'] },
	} }, new AbortController().signal);
	assert.deepEqual(result, { lane: SYNTAX_TOKENIZE_LANE, value: { tokens: [{ range: new Range(1, 1, 1, 6), tokenType: 'other', modifiers: [], languageId: 'embedded' }] } });
});
