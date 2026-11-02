import { raceCancellationError } from '../../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import type { LanguageCompletionProvider, LanguageCompletionProviderRegistration, LanguageCompletionProviderRequest, LanguageCompletionProviderResult } from '../../../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import type { ITextModel } from '../../../../../../../editor/common/model.js';
import { CHAT_INPUT_LANGUAGE_ID } from './chatInputCompletions.js';
import { isAtTriggerCharacterToken } from './chatInputCompletionUtils.js';

/** Registers host-backed candidates for one input model and its current draft lifetime. */
export abstract class AgentHostInputCompletionsBase extends Disposable {
	private readonly lifetime = new AbortController();
	private readonly providerId = `ash.chat.agentHost.${createUuid()}`;
	private readonly registration: LanguageCompletionProviderRegistration;

	constructor(
		protected readonly model: ITextModel,
		protected readonly currentLifecycle: () => AbortSignal,
		private readonly isEnabled: () => boolean,
		languageFeatures: ILanguageFeaturesService,
	) {
		super();
		this.registration = this._register(languageFeatures.completionProvider.registerGroup([]));
		this._register(toDisposable(() => this.lifetime.abort()));
	}

	protected registerProvider(provider: Omit<LanguageCompletionProvider, 'id' | 'languageIds'>): void {
		this.registration.replace([{
			...provider,
			triggerCharacters: provider.triggerCharacters,
			id: this.providerId,
			languageIds: [CHAT_INPUT_LANGUAGE_ID],
			provideCompletions: (request, signal) => this.provide(request, signal, provider),
			executeCompletionCommand: async (request, signal) => {
				if (!this.isCurrentInput(request.resource?.toString())) {
					return;
				}
				try {
					await provider.executeCompletionCommand?.(request, AbortSignal.any([signal, this.currentLifecycle(), this.lifetime.signal]));
				} catch (error) {
					if (!isCancellationError(error)) {
						throw error;
					}
				}
			},
		}]);
	}

	private isCurrentInput(resource: string | undefined): boolean {
		return !this.isDisposed && !this.model.isDisposed() && this.isEnabled() && resource === this.model.uri.toString();
	}

	private async provide(
		request: LanguageCompletionProviderRequest,
		signal: AbortSignal,
		provider: Omit<LanguageCompletionProvider, 'id' | 'languageIds'>,
	): Promise<LanguageCompletionProviderResult | undefined> {
		if (!this.isCurrentInput(request.resource?.toString()) || this.model.getVersionId() !== request.snapshot.version
			|| !isAtTriggerCharacterToken(this.model, request.position, provider.triggerCharacters ?? [])) {
			return undefined;
		}
		const draft = this.currentLifecycle();
		const cancellation = AbortSignal.any([signal, draft, this.lifetime.signal]);
		try {
			const result = await raceCancellationError(Promise.resolve(provider.provideCompletions(request, cancellation)), cancellation);
			if (cancellation.aborted || draft !== this.currentLifecycle() || !this.isCurrentInput(request.resource?.toString()) || this.model.getVersionId() !== request.snapshot.version) {
				return undefined;
			}
			return result;
		} catch (error) {
			if (cancellation.aborted || isCancellationError(error)) {
				return undefined;
			}
			throw error;
		}
	}
}
