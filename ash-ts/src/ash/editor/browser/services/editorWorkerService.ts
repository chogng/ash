import { type LanguageCompletionRequest, type LanguageCompletionProvider, type LanguageCompletionResult, type IInplaceReplaceSupportResult, type TextEdit } from '../../common/languages.js';
import { BrowserWorkerClientPort } from '../../../platform/webWorker/browser/browserWorkerClientPort.js';
import { LanguageWorkerWireClient } from '../../common/services/languageWorkerWire.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Range } from '../../common/core/range.js';
import { LanguageRequestCoordinator, LanguageRequestStatus } from '../../common/model/languageRequestCoordinator.js';
import { type TextModel } from '../../common/model/textModel.js';
import { editorWorkerWireCodec, EDITOR_WORKER_TEXTUAL_SUGGEST_LANE, EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerImplementationFactory, type EditorWorkerLane, type EditorWorkerRequest, type EditorWorkerResult } from '../../common/services/editorWorkerWire.js';
import { type UnicodeHighlight } from '../../common/services/unicodeTextModelHighlighter.js';

export type VersionedEditorWorkerFactory = (model: TextModel) => IVersionedEditorWorkerClient;

export const IVersionedEditorWorkerClient = createServiceIdentifier<IVersionedEditorWorkerClient>('versionedEditorWorkerClient');

export interface IVersionedEditorWorkerClient extends IDisposable {
	textualSuggest(request: LanguageCompletionRequest, signal?: AbortSignal): Promise<LanguageCompletionResult | undefined>;
	computeUnicodeHighlights(signal?: AbortSignal): Promise<readonly UnicodeHighlight[] | undefined>;
	computeMoreMinimalEdits(edits: readonly TextEdit[], signal?: AbortSignal): Promise<readonly TextEdit[] | undefined>;
	navigateValueSet(range: Range, up: boolean, wordDefinition: RegExp, signal?: AbortSignal): Promise<IInplaceReplaceSupportResult | undefined>;
}

/** Browser-side editor worker client with model-version gating and one reusable worker implementation. */
export class VersionedEditorWorkerClient extends Disposable implements IVersionedEditorWorkerClient {
	private readonly coordinator: LanguageRequestCoordinator<EditorWorkerLane, EditorWorkerRequest, EditorWorkerResult>;

	constructor(model: TextModel, createWorker: EditorWorkerImplementationFactory = () => new LanguageWorkerWireClient(
		new BrowserWorkerClientPort(new Worker(new URL('../../common/services/editorWebWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-editor' })),
		editorWorkerWireCodec,
	)) {
		super();
		this.coordinator = this._register(new LanguageRequestCoordinator(model, createWorker));
	}

	textualSuggest(request: LanguageCompletionRequest, signal?: AbortSignal): Promise<LanguageCompletionResult | undefined> {
		return this.run(EDITOR_WORKER_TEXTUAL_SUGGEST_LANE, request, signal) as Promise<LanguageCompletionResult | undefined>;
	}

	computeUnicodeHighlights(signal?: AbortSignal): Promise<readonly UnicodeHighlight[] | undefined> {
		return this.run(EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, Object.freeze({}), signal) as Promise<readonly UnicodeHighlight[] | undefined>;
	}

	computeMoreMinimalEdits(edits: readonly TextEdit[], signal?: AbortSignal): Promise<readonly TextEdit[] | undefined> {
		return this.run(EDITOR_WORKER_MINIMAL_EDITS_LANE, Object.freeze({ edits: Object.freeze([...edits]) }), signal) as Promise<readonly TextEdit[] | undefined>;
	}

	navigateValueSet(range: Range, up: boolean, wordDefinition: RegExp, signal?: AbortSignal): Promise<IInplaceReplaceSupportResult | undefined> {
		return this.run(EDITOR_WORKER_NAVIGATE_VALUE_LANE, Object.freeze({ range, up, wordDefinition }), signal) as Promise<IInplaceReplaceSupportResult | undefined>;
	}

	private async run(lane: EditorWorkerLane, payload: EditorWorkerRequest, signal?: AbortSignal): Promise<EditorWorkerResult> {
		let value: EditorWorkerResult;
		const outcome = await this.coordinator.runLatest(lane, payload, result => {
			value = result.value;
		}, signal ? { signal } : {});
		return outcome.status === LanguageRequestStatus.Applied ? value : undefined;
	}
}

export class WordBasedCompletionItemProvider implements LanguageCompletionProvider {
	readonly id = 'language.word';
	readonly languageIds = ['*'];

	constructor(private readonly worker: IVersionedEditorWorkerClient) {}

	provideCompletions(request: LanguageCompletionRequest, signal: AbortSignal): Promise<LanguageCompletionResult | undefined> {
		return this.worker.textualSuggest(request, signal);
	}
}
