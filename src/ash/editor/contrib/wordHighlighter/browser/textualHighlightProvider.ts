import { ResourceMap } from '../../../../base/common/map.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Position } from '../../../common/core/position.js';
import { USUAL_WORD_SEPARATORS } from '../../../common/core/wordHelper.js';
import { DocumentHighlightKind, type DocumentHighlight, type DocumentHighlightProvider, type MultiDocumentHighlightProvider } from '../../../common/languages.js';
import { type ITextModel } from '../../../common/model.js';
import type { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';

const MAX_TEXTUAL_HIGHLIGHTS = 10_000;
const registrations = new WeakMap<ILanguageFeaturesService, TextualProviderRegistration>();

interface TextualProviderRegistration {
	count: number;
	readonly store: DisposableStore;
}

class TextualDocumentHighlightProvider implements DocumentHighlightProvider, MultiDocumentHighlightProvider {
	readonly selector = Object.freeze({ language: '*' });

	provideDocumentHighlights(model: ITextModel, position: Position, token: CancellationToken): DocumentHighlight[] {
		return findHighlights(model, position, token);
	}

	provideMultiDocumentHighlights(primaryModel: ITextModel, position: Position, otherModels: ITextModel[], token: CancellationToken): ResourceMap<DocumentHighlight[]> {
		if (primaryModel.isDisposed() || token.isCancellationRequested) return new ResourceMap();
		const word = primaryModel.getWordAtPosition(position);
		if (!word) return new ResourceMap();
		const result = new ResourceMap<DocumentHighlight[]>();
		for (const model of [primaryModel, ...otherModels]) {
			if (token.isCancellationRequested) return new ResourceMap();
			if (model.isDisposed()) continue;
			result.set(model.uri, findText(model, word.word, token));
		}
		return result;
	}
}

export class TextualMultiDocumentHighlightFeature extends Disposable {
	constructor(languageFeaturesService: ILanguageFeaturesService) {
		super();
		this._register(acquireTextualHighlightProviders(languageFeaturesService));
	}
}

function acquireTextualHighlightProviders(service: ILanguageFeaturesService): IDisposable {
	let registration = registrations.get(service);
	if (!registration) {
		const provider = new TextualDocumentHighlightProvider();
		const store = new DisposableStore();
		store.add(service.documentHighlightProvider.register(provider.selector, provider));
		store.add(service.multiDocumentHighlightProvider.register(provider.selector, provider));
		registration = { count: 0, store };
		registrations.set(service, registration);
	}
	registration.count += 1;
	return toDisposable(() => {
		const current = registrations.get(service);
		if (!current) return;
		current.count -= 1;
		if (current.count > 0) return;
		registrations.delete(service);
		current.store.dispose();
	});
}

function findHighlights(model: ITextModel, position: Position, token: CancellationToken): DocumentHighlight[] {
	if (token.isCancellationRequested) return [];
	if (model.isDisposed()) return [];
	const word = model.getWordAtPosition(position);
	return word ? findText(model, word.word, token) : [];
}

function findText(model: ITextModel, text: string, token: CancellationToken): DocumentHighlight[] {
	const matches = model.findMatches(text, true, false, true, USUAL_WORD_SEPARATORS, false, MAX_TEXTUAL_HIGHLIGHTS);
	const highlights: DocumentHighlight[] = [];
	for (const match of matches) {
		if (token.isCancellationRequested) return [];
		highlights.push(Object.freeze({ range: match.range, kind: DocumentHighlightKind.Text }));
	}
	return highlights;
}
