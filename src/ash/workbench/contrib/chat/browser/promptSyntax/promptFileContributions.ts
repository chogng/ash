import { PromptToolsCodeLensProvider } from './promptToolsCodeLensProvider.js';
import { PromptCodingAgentActionOverlayWidget } from './promptCodingAgentActionOverlay.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptLinkProvider } from '../../common/promptSyntax/languageProviders/promptLinkProvider.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { PromptFileParser } from '../../common/promptSyntax/promptFileParser.js';
import { PromptHeaderAutocompletion } from '../../common/promptSyntax/languageProviders/promptHeaderAutocompletion.js';
import { PromptHoverProvider } from '../../common/promptSyntax/languageProviders/promptHovers.js';
import { MARKERS_OWNER_ID, PromptValidator } from '../../common/promptSyntax/languageProviders/promptValidator.js';
import { getPromptFileType, PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { PromptCodeActionProvider } from '../../common/promptSyntax/languageProviders/promptCodeActions.js';
import { PromptHeaderDefinitionProvider } from '../../common/promptSyntax/languageProviders/PromptHeaderDefinitionProvider.js';
import { PromptBodyAutocompletion } from '../../common/promptSyntax/languageProviders/promptBodyAutocompletion.js';

/** Contributes draft language features without replacing host language providers or catalog state. */
export class PromptLanguageFeaturesProvider extends Disposable {
	public static readonly ID = 'chat.promptLanguageFeatures';
	private readonly models = this._register(new DisposableMap<ITextModel, DisposableStore>());
	private readonly editors = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
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
		@ICodeEditorService codeEditors: ICodeEditorService,
	) {
		super();
		this._register(features.completionProvider.register(instantiationService.createInstance(PromptHeaderAutocompletion)));
		this._register(features.completionProvider.register(instantiationService.createInstance(PromptBodyAutocompletion)));
		this._register(features.hoverProvider.register(['markdown'], new PromptHoverProvider()));
		this._register(features.codeLensProvider.register(['markdown'], instantiationService.createInstance(PromptToolsCodeLensProvider)));
		this._register(features.codeActionProvider.register(['markdown'], new PromptCodeActionProvider()));
		this._register(features.definitionProvider.register(['markdown'], instantiationService.createInstance(PromptHeaderDefinitionProvider)));
		this._register(features.linkProvider.register(['markdown'], instantiationService.createInstance(PromptLinkProvider)));
		this._register(textModels.registerTextModelContentProvider(Schemas.internal, {
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
					return this.modelService.getModel(resource) ?? this.modelService.createModel(parsed.content, languages.createByFilepathOrFirstLine(resource, parsed.content.split('\n', 1)[0]), resource);
				} finally { this.readers.delete(cleanup); cleanup.dispose(); }
			},
		}));
		const attach = (editor: ICodeEditor): void => {
			if (this.editors.has(editor)) { return; }
			const lifetime = this.editors.set(editor, new DisposableStore());
			lifetime.add(editor.onDidChangeModel(() => this.updateModels()));
			if (!editor.isSimpleWidget) {
				let overlay: PromptCodingAgentActionOverlayWidget | undefined;
				const updateOverlay = () => {
					if (getPromptFileType(editor.getModel()?.uri) === PromptsType.agent) {
						overlay ??= instantiationService.createInstance(PromptCodingAgentActionOverlayWidget, editor);
					} else {
						overlay?.dispose();
						overlay = undefined;
					}
				};
				lifetime.add(toDisposable(() => overlay?.dispose()));
				lifetime.add(editor.onDidChangeModel(updateOverlay));
				updateOverlay();
			}
			lifetime.add(editor.onDidDispose(() => {
				this.editors.deleteAndDispose(editor);
				this.updateModels();
			}));
			this.updateModels();
		};
		this._register(codeEditors.onCodeEditorAdd(attach));
		this._register(codeEditors.onCodeEditorRemove(editor => {
			this.editors.deleteAndDispose(editor);
			this.updateModels();
		}));
		this._register(modelService.onModelLanguageChanged(() => this.updateModels()));
		this._register(modelService.onModelRemoved(model => this.models.deleteAndDispose(model)));
		for (const editor of codeEditors.listCodeEditors()) { attach(editor); }
	}

	private updateModels(): void {
		// Resolver and preview models can outlive their editors. Only an editor binding
		// acquires diagnostics; two editors sharing a model keep one validation lifetime.
		const active = new Set<ITextModel>();
		for (const editor of this.editors.keys()) {
			const model = editor.getModel();
			if (model && !model.isDisposed() && model.getLanguageId() === 'markdown' && getPromptFileType(model.uri)) {
				active.add(model);
			}
		}
		for (const model of this.models.keys()) {
			if (!active.has(model)) { this.models.deleteAndDispose(model); }
		}
		for (const model of active) { this.track(model); }
	}

	private track(model: ITextModel): void {
		if (this.models.has(model)) { return; }
		const lifetime = this.models.set(model, new DisposableStore());
		const validate = () => {
			const diagnostics = this.validator.validate(this.parser.parse(model.uri, model.getValue()));
			this.markerService.changeOne(MARKERS_OWNER_ID, model.uri, diagnostics.map(diagnostic => ({
				startLineNumber: diagnostic.range.startLineNumber,
				startColumn: diagnostic.range.startColumn,
				endLineNumber: diagnostic.range.endLineNumber,
				endColumn: diagnostic.range.endColumn,
				severity: diagnostic.severity === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Error,
				message: diagnostic.message, source: diagnostic.source,
				...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
			})));
		};
		const scheduled = lifetime.add(new RunOnceScheduler(validate, 100));
		lifetime.add(model.onDidChangeContent(() => scheduled.schedule()));
		lifetime.add(model.onWillDispose(() => this.models.deleteAndDispose(model)));
		lifetime.add(toDisposable(() => this.markerService.remove(MARKERS_OWNER_ID, [model.uri])));
		validate();
	}
}
