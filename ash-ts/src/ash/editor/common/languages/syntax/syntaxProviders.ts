import { isNonEmptyArray } from "../../../../base/common/arrays.js";
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { assertLanguageId } from '../language.js';
import { assertLanguageSelector } from '../../languageSelector.js';
import { type LanguageDiagnosticResult, type LanguageTokenResult } from "../languageResults.js";
import { type LanguageWorkerDocumentSynchronization } from '../../services/textModelSync/textModelSync.protocol.js';
import { type TextSnapshot } from "../../core/textChange.js";

export interface SyntaxRequest {
	readonly languageId: string;
}

export interface SyntaxProviderRequest extends SyntaxRequest {
	readonly requestId: number;
	readonly snapshot: TextSnapshot;
}

export interface SyntaxProvider {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly tokenPriority?: number;
	readonly diagnosticPriority?: number;
	provideTokens?(request: SyntaxProviderRequest, signal: AbortSignal): LanguageTokenResult | undefined | PromiseLike<LanguageTokenResult | undefined>;
	provideDiagnostics?(request: SyntaxProviderRequest, signal: AbortSignal): LanguageDiagnosticResult | undefined | PromiseLike<LanguageDiagnosticResult | undefined>;
	synchronizeDocument?(synchronization: LanguageWorkerDocumentSynchronization): void;
}

export interface RegisteredSyntaxProvider {
	readonly id: string;
	readonly languageIds: readonly string[];
	readonly tokenPriority: number;
	readonly diagnosticPriority: number;
	readonly provideTokens?: NonNullable<SyntaxProvider["provideTokens"]>;
	readonly provideDiagnostics?: NonNullable<SyntaxProvider["provideDiagnostics"]>;
	readonly synchronizeDocument?: NonNullable<SyntaxProvider["synchronizeDocument"]>;
}

/** Caller-owned registry for snapshot tokenization and diagnostic providers. */
export class SyntaxProviderRegistry extends Disposable {
	private readonly providers = new Map<string, RegisteredSyntaxProvider>();
	private readonly changeEmitter = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.providers.clear();
		}));
	}

	register(provider: SyntaxProvider): IDisposable {
		return this.registerMany([provider]);
	}

	registerMany(providers: readonly SyntaxProvider[]): IDisposable {
		this.assertNotDisposed();
		if (!isNonEmptyArray(providers)) {
			throw new TypeError("Syntax provider batch must not be empty");
		}
		const registered = providers.map(normalizeProvider);
		const identities = new Set<string>();
		for (const provider of registered) {
			if (identities.has(provider.id) || this.providers.has(provider.id)) {
				throw new RangeError(`Syntax provider '${provider.id}' is already registered`);
			}
			identities.add(provider.id);
		}
		for (const provider of registered) this.providers.set(provider.id, provider);
		this.changeEmitter.fire();
		return toDisposable(() => {
			let changed = false;
			for (const provider of registered) {
				if (this.providers.get(provider.id) === provider) {
					this.providers.delete(provider.id);
					changed = true;
				}
			}
			if (changed) this.changeEmitter.fire();
		});
	}

	getTokenProvider(languageId: string): RegisteredSyntaxProvider | undefined {
		return this.getTokenProviders(languageId)[0];
	}

	getTokenProviders(languageId: string): readonly RegisteredSyntaxProvider[] {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		const selected: RegisteredSyntaxProvider[] = [];
		for (const provider of this.providers.values()) {
			if (!provider.provideTokens || !matchesLanguage(provider, languageId)) continue;
			const index = selected.findIndex(candidate => provider.tokenPriority > candidate.tokenPriority);
			if (index < 0) selected.push(provider);
			else selected.splice(index, 0, provider);
		}
		return Object.freeze(selected);
	}

	getDiagnosticProviders(languageId: string): readonly RegisteredSyntaxProvider[] {
		this.assertNotDisposed();
		assertLanguageId(languageId);
		const selected = [...this.providers.values()]
			.filter(provider => provider.provideDiagnostics && matchesLanguage(provider, languageId))
			.sort((left, right) => right.diagnosticPriority - left.diagnosticPriority);
		if (selected.length === 0) return Object.freeze([]);
		const priority = selected[0]!.diagnosticPriority;
		return Object.freeze(selected.filter(provider => provider.diagnosticPriority === priority));
	}

	getDocumentSynchronizers(): readonly RegisteredSyntaxProvider[] {
		this.assertNotDisposed();
		return Object.freeze([...this.providers.values()].filter(provider => provider.synchronizeDocument));
	}

}

export function assertSyntaxRequest(request: SyntaxRequest): void {
	if (typeof request !== "object" || request === null) {
		throw new TypeError("Syntax request must be an object");
	}
	assertLanguageId(request.languageId);
}

function normalizeProvider(provider: SyntaxProvider): RegisteredSyntaxProvider {
	if (typeof provider !== "object" || provider === null) {
		throw new TypeError("Syntax provider must be an object");
	}
	assertIdentifier(provider.id, "Syntax provider ID");
	if (!isNonEmptyArray(provider.languageIds)) {
		throw new TypeError("Syntax provider must declare language IDs");
	}
	const languageIds = provider.languageIds.map(languageId => {
		assertLanguageSelector(languageId);
		return languageId;
	});
	if (new Set(languageIds).size !== languageIds.length) {
		throw new RangeError("Syntax provider language IDs must be unique");
	}
	if (provider.provideTokens !== undefined && typeof provider.provideTokens !== "function") {
		throw new TypeError("Syntax provider provideTokens must be a function");
	}
	if (provider.tokenPriority !== undefined && (!Number.isSafeInteger(provider.tokenPriority) || !provider.provideTokens)) {
		throw new TypeError("Syntax provider token priority requires a token provider and must be a safe integer");
	}
	if (provider.provideDiagnostics !== undefined && typeof provider.provideDiagnostics !== "function") {
		throw new TypeError("Syntax provider provideDiagnostics must be a function");
	}
	if (provider.diagnosticPriority !== undefined && (!Number.isSafeInteger(provider.diagnosticPriority) || !provider.provideDiagnostics)) {
		throw new TypeError("Syntax provider diagnostic priority requires a diagnostic provider and must be a safe integer");
	}
	if (provider.synchronizeDocument !== undefined && typeof provider.synchronizeDocument !== "function") {
		throw new TypeError("Syntax provider synchronizeDocument must be a function");
	}
	if (!provider.provideTokens && !provider.provideDiagnostics) {
		throw new TypeError("Syntax provider must implement tokens or diagnostics");
	}
	return Object.freeze({
		id: provider.id,
		languageIds: Object.freeze(languageIds),
		tokenPriority: provider.tokenPriority ?? 0,
		diagnosticPriority: provider.diagnosticPriority ?? 0,
		...(provider.provideTokens === undefined ? {} : { provideTokens: provider.provideTokens.bind(provider) }),
		...(provider.provideDiagnostics === undefined ? {} : { provideDiagnostics: provider.provideDiagnostics.bind(provider) }),
		...(provider.synchronizeDocument === undefined ? {} : { synchronizeDocument: provider.synchronizeDocument.bind(provider) }),
	});
}

function matchesLanguage(provider: RegisteredSyntaxProvider, languageId: string): boolean {
	return provider.languageIds.includes("*") || provider.languageIds.includes(languageId);
}

function assertIdentifier(value: unknown, owner: string): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new TypeError(`${owner} must contain only letters, digits, dot, underscore, or hyphen`);
	}
}
