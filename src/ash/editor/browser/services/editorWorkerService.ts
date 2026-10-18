import { type LanguageCompletionRequest, type LanguageCompletionProvider, type LanguageCompletionResult, type IInplaceReplaceSupportResult, type TextEdit } from '../../common/languages.js';
import type { IWebWorkerService } from '../../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerDescriptor } from '../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Range } from '../../common/core/range.js';
import { LanguageRequestCoordinator, LanguageRequestStatus } from '../../common/model/languageRequestCoordinator.js';
import { type TextModel } from '../../common/model/textModel.js';
import { type UnicodeHighlight } from '../../common/services/unicodeTextModelHighlighter.js';
import { WorkerTextModelSyncClient, modelChannel } from '../../common/services/textModelSync/textModelSync.impl.js';
import { editorWorkerWireCodec } from '../../common/services/editorWebWorker.js';
import { EDITOR_WORKER_TEXTUAL_SUGGEST_LANE, EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerImplementationFactory, type EditorWorkerLane, type EditorWorkerRequest, type EditorWorkerResult } from '../../common/services/editorWorker.js';

export type VersionedEditorWorkerFactory = (model: TextModel) => IVersionedEditorWorkerClient;

export const IVersionedEditorWorkerClient = createServiceIdentifier<IVersionedEditorWorkerClient>('versionedEditorWorkerClient');

export interface IVersionedEditorWorkerClient extends IDisposable {
	textualSuggest(request: LanguageCompletionRequest, signal?: AbortSignal): Promise<LanguageCompletionResult | undefined>;
	computeUnicodeHighlights(signal?: AbortSignal): Promise<readonly UnicodeHighlight[] | undefined>;
	computeMoreMinimalEdits(edits: readonly TextEdit[], signal?: AbortSignal): Promise<readonly TextEdit[] | undefined>;
	navigateValueSet(range: Range, up: boolean, wordDefinition: RegExp, signal?: AbortSignal): Promise<IInplaceReplaceSupportResult | undefined>;
}

/** The host chooses the shared Worker policy; the client still owns one model lifetime. */
export function createEditorWorkerClient(model: TextModel, workers: IWebWorkerService): VersionedEditorWorkerClient {
	return new VersionedEditorWorkerClient(model, () => new WorkerTextModelSyncClient(workers.createWorkerClient(new WebWorkerDescriptor({
		label: 'ash-editor', channel: modelChannel,
		createWorker: () => new Worker(new URL('../../common/services/editorWebWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-editor' }),
	})), editorWorkerWireCodec));
}

/** Browser-side editor worker client with model-version gating and one reusable worker implementation. */
export class VersionedEditorWorkerClient extends Disposable implements IVersionedEditorWorkerClient {
	private readonly coordinator: LanguageRequestCoordinator<EditorWorkerLane, EditorWorkerRequest, EditorWorkerResult>;

	constructor(model: TextModel, createWorker: EditorWorkerImplementationFactory) {
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

	constructor(private readonly worker: IVersionedEditorWorkerClient) { }

	provideCompletions(request: LanguageCompletionRequest, signal: AbortSignal): Promise<LanguageCompletionResult | undefined> {
		return this.worker.textualSuggest(request, signal);
	}
}
