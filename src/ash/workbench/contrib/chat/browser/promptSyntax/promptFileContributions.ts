import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptLinkProvider } from '../../common/promptSyntax/languageProviders/promptLinkProvider.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { PromptFileParser } from '../../common/promptSyntax/promptFileParser.js';
import { PromptHeaderAutocompletion } from '../../common/promptSyntax/languageProviders/promptHeaderAutocompletion.js';
import { PromptHoverProvider } from '../../common/promptSyntax/languageProviders/promptHovers.js';
import { PromptValidator } from '../../common/promptSyntax/languageProviders/promptValidator.js';

/** Contributes draft language features without replacing host language providers or catalog state. */
export class PromptLanguageFeaturesProvider extends Disposable {
	public static readonly ID = 'chat.promptLanguageFeatures';
	private readonly models = this._register(new DisposableMap<ITextModel, DisposableStore>());
	private readonly readers = this._register(new DisposableStore());
	private readonly parser = new PromptFileParser();
	private readonly validator = new PromptValidator();

	constructor(
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@IModelService private readonly modelService: IModelService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageService languages: ILanguageService,
		@ITextModelService textModels: ITextModelService,
		@IPromptsService prompts: IPromptsService,
	) {
		super();
		this._register(
			features.completionProvider.register(instantiationService.createInstance(PromptHeaderAutocompletion)),
		);
		this._register(features.hoverProvider.register(['markdown'], new PromptHoverProvider()));
		this._register(features.linkProvider.register(['markdown'], new PromptLinkProvider()));
		this._register(
			textModels.registerTextModelContentProvider(Schemas.internal, {
				provideTextContent: async resource => {
					if (resource.authority !== 'skill') return null;
					if (this.isDisposed) return null;
					const existing = this.modelService.getModel(resource);
					if (existing) return existing;
					const cancellation = new CancellationTokenSource();
					const cleanup = this.readers.add(toDisposable(() => cancellation.dispose(true)));
					try {
						const parsed = await prompts.parseNew(resource, cancellation.token);
						if (this.isDisposed || cancellation.token.isCancellationRequested) return null;
						return (
							this.modelService.getModel(resource) ??
							this.modelService.createModel(
								parsed.content,
								languages.createByFilepathOrFirstLine(resource, parsed.content.split('\n', 1)[0]),
								resource,
							)
						);
					} finally {
						this.readers.delete(cleanup);
						cleanup.dispose();
					}
				},
			}),
		);
		this._register(modelService.onModelAdded(model => this.track(model)));
		this._register(modelService.onModelLanguageChanged(({ model }) => this.track(model)));
		this._register(modelService.onModelRemoved(model => this.models.deleteAndDispose(model)));
		for (const model of modelService.getModels()) this.track(model);
	}

	private track(model: ITextModel): void {
		if (model.getLanguageId() !== 'markdown' || !model.uri.path.endsWith('/SKILL.md')) {
			this.models.deleteAndDispose(model);
			return;
		}
		if (this.models.has(model)) return;
		const lifetime = this.models.set(model, new DisposableStore());
		const validate = () => {
			const diagnostics = this.validator.validate(this.parser.parse(model.uri, model.getValue()));
			this.markerService.changeOne(
				PromptLanguageFeaturesProvider.ID,
				model.uri,
				diagnostics.map(diagnostic => ({
					startLineNumber: diagnostic.range.startLineNumber,
					startColumn: diagnostic.range.startColumn,
					endLineNumber: diagnostic.range.endLineNumber,
					endColumn: diagnostic.range.endColumn,
					severity: diagnostic.severity === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Error,
					message: diagnostic.message,
					source: diagnostic.source,
					...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
				})),
			);
		};
		const scheduled = lifetime.add(new RunOnceScheduler(validate, 100));
		lifetime.add(model.onDidChangeContent(() => scheduled.schedule()));
		lifetime.add(model.onWillDispose(() => this.models.deleteAndDispose(model)));
		lifetime.add(toDisposable(() => this.markerService.remove(PromptLanguageFeaturesProvider.ID, [model.uri])));
		validate();
	}
}
