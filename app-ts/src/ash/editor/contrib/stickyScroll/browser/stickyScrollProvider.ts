import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption, type EditorStickyScrollOptions } from '../../../common/config/editorOptions.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import type { EditorFoldingModel } from '../../folding/browser/foldingModel.js';
import type { StickyModel, StickyRange } from './stickyScrollElement.js';
import { StickyModelProvider } from './stickyScrollModelProvider.js';

export class StickyLineCandidate {
	constructor(
		public readonly startLineNumber: number,
		public readonly endLineNumber: number,
		public readonly top: number,
		public readonly height: number,
	) {}
}

export interface IStickyLineCandidateProvider {
	readonly onDidChangeStickyScroll: Event<void>;
	getVersionId(): number | undefined;
	update(): Promise<void>;
	getCandidateStickyLinesIntersecting(range: StickyRange): StickyLineCandidate[];
	dispose(): void;
}

export class StickyLineCandidateProvider extends Disposable implements IStickyLineCandidateProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeStickyScroll = this.changeEmitter.event;
	private readonly modelProvider: StickyModelProvider;
	private readonly scheduler = this._register(new RunOnceScheduler(() => void this.update(), 50));
	private model: StickyModel | null = null;
	private request: CancellationTokenSource | undefined;
	private options: EditorStickyScrollOptions;

	constructor(
		private readonly editor: ICodeEditor,
		folding: EditorFoldingModel,
		private readonly onError: (error: unknown) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		this.options = editor.getOption(EditorOption.stickyScroll);
		this.modelProvider = this._register(instantiationService.createInstance(StickyModelProvider, editor, folding, onError));
		this._register(toDisposable(() => this.request?.dispose(true)));
		this._register(folding.onDidChange(() => this.schedule()));
		this._register(editor.onDidChangeModelContent(() => this.schedule()));
		this._register(folding.model.onDidChangeLanguage(() => this.schedule(true)));
		this._register(languageFeaturesService.documentSymbolProvider.onDidChange(() => this.schedule(true)));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.stickyScroll)) {
				const options = editor.getOption(EditorOption.stickyScroll);
				const changed = options.enabled !== this.options.enabled || options.defaultModel !== this.options.defaultModel;
				this.options = options;
				if (changed) {
					this.schedule(true);
				}
			}
			if (event.hasChanged(EditorOption.folding)) {
				this.schedule();
			}
		}));
	}

	public getVersionId(): number | undefined {
		return this.model?.version;
	}

	public async update(): Promise<void> {
		this.scheduler.cancel();
		this.request?.dispose(true);
		if (this.isDisposed || !this.editor.getOption(EditorOption.stickyScroll).enabled) {
			return;
		}
		const request = this.request = new CancellationTokenSource();
		try {
			const model = await this.modelProvider.update(request.token);
			if (request.token.isCancellationRequested || this.isDisposed || model?.version !== this.editor.getModel()?.getVersionId()) {
				return;
			}
			this.model = model;
			this.changeEmitter.fire();
		} catch (error) {
			if (!request.token.isCancellationRequested) {
				this.onError(error);
			}
		} finally {
			request.dispose();
			if (this.request === request) {
				this.request = undefined;
			}
		}
	}

	public getCandidateStickyLinesIntersecting(range: StickyRange): StickyLineCandidate[] {
		const result: StickyLineCandidate[] = [];
		const hidden = this.editor._getViewModel()!.getHiddenAreas();
		const height = this.editor.getOption(EditorOption.lineHeight);
		const pending = [...this.model?.element?.children ?? []].reverse();
		while (pending.length > 0) {
			const element = pending.pop()!;
			const scope = element.range!;
			if (scope.startLineNumber > range.endLineNumber || scope.endLineNumber <= range.startLineNumber) {
				continue;
			}
			if (hidden.some(area => scope.startLineNumber >= area.startLineNumber && scope.startLineNumber <= area.endLineNumber)) {
				continue;
			}
			let depth = 0;
			for (let parent = element.parent; parent?.range; parent = parent.parent) {
				depth++;
			}
			result.push(new StickyLineCandidate(scope.startLineNumber, scope.endLineNumber - 1, depth * height, height));
			pending.push(...element.children.slice().reverse());
		}
		return result;
	}

	private schedule(clear = false): void {
		this.request?.dispose(true);
		if (clear || !this.options.enabled || this.model?.version !== this.editor.getModel()?.getVersionId()) {
			this.model = null;
			this.changeEmitter.fire();
		}
		this.scheduler.schedule();
	}
}
