import { Emitter, type Event } from "../../../base/common/event.js";
import { StringSHA1 } from '../../../base/common/hash.js';
import { Disposable, DisposableMap, type IDisposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import type { IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import '../config/editorConfigurationSchema.js';
import { EditOperation, type ISingleEditOperation } from '../core/editOperation.js';
import { Range } from '../core/range.js';
import { DefaultEndOfLine, EndOfLinePreference, EndOfLineSequence, type ITextBuffer, type ITextBufferFactory, type ITextModel, type ITextModelCreationOptions } from '../model.js';
import { createPieceTreeTextBuffer } from '../model/textBufferFactory.js';
import { TextModel, type TextModelUndoRedoSnapshot } from "../model/textModel.js";
import type { ILanguageSelection, IAshLanguageService } from '../languages/language.js';
import type { ILanguageConfigurationService } from '../languages/languageConfigurationRegistry.js';
import type { ILanguageFeaturesService } from './languageFeatures.js';
import { type SyntaxServiceOptions } from '../languages.js';
import type { IModelService } from "./model.js";
import type { TextModelEditSource } from '../textModelEditSource.js';
import type { ITextResourcePropertiesService } from './textResourceConfiguration.js';

export interface ModelServiceTokenizationOptions {
	readonly syntaxService?: SyntaxServiceOptions;
	readonly onDidChangeLanguageSupport?: Event<void>;
}

/** Resource and language registry for caller-owned TextModels. */
export class ModelService extends Disposable implements IModelService {
	public static MAX_MEMORY_FOR_CLOSED_FILES_UNDO_STACK = 20 * 1024 * 1024;

	private readonly _models = this._register(new DisposableMap<string, ModelData>());
	private readonly _disposedModels = new Map<string, DisposedModelInfo>();
	private _disposedModelsHeapSize = 0;
	private _modelCreationOptionsByLanguageAndResource: Record<string, ITextModelCreationOptions> = Object.create(null) as Record<string, ITextModelCreationOptions>;
	private readonly _onModelAdded = this._register(new Emitter<TextModel>());
	private readonly _onModelRemoved = this._register(new Emitter<TextModel>());
	private readonly _onModelModeChanged = this._register(new Emitter<{ readonly model: TextModel; readonly oldLanguageId: string }>());
	readonly _serviceBrand: undefined;

	readonly onModelAdded = this._onModelAdded.event;
	readonly onModelRemoved = this._onModelRemoved.event;
	readonly onModelLanguageChanged = this._onModelModeChanged.event;

	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _resourcePropertiesService: ITextResourcePropertiesService,
		private readonly _languageService?: IAshLanguageService,
		private readonly _languageFeaturesService?: ILanguageFeaturesService,
		private readonly _languageConfigurationService?: ILanguageConfigurationService,
		private readonly _tokenizationOptions: ModelServiceTokenizationOptions = {},
	) {
		super();
		this._register(this._configurationService.onDidChangeConfiguration(event => this._updateModelOptions(event)));
	}

	createModel(value: string | ITextBufferFactory, languageSelection: ILanguageSelection | null, resource?: URI, isForSimpleWidget = false): TextModel {
		if (typeof value !== 'string' && !isTextBufferFactory(value)) throw new TypeError('Model value must be a string or ITextBufferFactory');
		if (resource && this._models.has(resource.toString())) throw new Error(`A model already exists for '${resource.toString()}'`);
		const creationOptions = this.getCreationOptions(languageSelection?.languageId ?? 'plaintext', resource, isForSimpleWidget);
		const model = new TextModel(readModelValue(value, creationOptions.defaultEOL), {
			resource,
			languageId: languageSelection?.languageId,
			isForSimpleWidget: creationOptions.isForSimpleWidget,
			tabSize: creationOptions.tabSize,
			indentSize: creationOptions.indentSize,
			insertSpaces: creationOptions.insertSpaces,
			defaultEOL: creationOptions.defaultEOL,
			trimAutoWhitespace: creationOptions.trimAutoWhitespace,
			largeFileOptimizations: creationOptions.largeFileOptimizations,
			bracketPairColorizationOptions: creationOptions.bracketPairColorizationOptions,
			languageConfigurationService: this._languageConfigurationService,
			...(this._languageService && this._languageFeaturesService ? {
					tokenization: {
						languageIdCodec: this._languageService.languageIdCodec,
						syntaxProviderRegistry: this._languageFeaturesService.syntaxProvider,
						documentSemanticTokensProvider: this._languageFeaturesService.documentSemanticTokensProvider,
						...this._tokenizationOptions,
					},
			} : {}),
		});
		if (creationOptions.detectIndentation) model.detectIndentation(creationOptions.insertSpaces, creationOptions.tabSize);
		if (languageSelection) model.setLanguage(languageSelection);
		const key = model.uri.toString();
		const disposedModel = this._removeDisposedModel(model.uri);
		if (disposedModel) {
			const sha1Computer = this._getSHA1Computer();
			if (sha1Computer.canComputeSHA1(model) && sha1Computer.computeSHA1(model) === disposedModel.sha1) {
				model.restoreUndoRedoSnapshot(disposedModel.snapshot);
			}
		}
		if (this._models.has(key)) {
			model.dispose();
			throw new Error(`A model already exists for '${key}'`);
		}
		try {
			const modelData = this._createModelData(model, key);
			this._models.set(key, modelData);
			this._onModelAdded.fire(model);
			return model;
		} catch (error) {
			model.dispose();
			throw error;
		}
	}

	updateModel(model: ITextModel, value: string | ITextBufferFactory, reason?: TextModelEditSource): void {
		const modelData = [...this._models].find(([, candidate]) => candidate.model === model)?.[1];
		if (!modelData) throw new ReferenceError('Text model is not registered with this model service');
		const concreteModel = modelData.model;
		if (typeof value !== 'string' && !isTextBufferFactory(value)) throw new TypeError('Model value must be a string or ITextBufferFactory');
		const { textBuffer, disposable } = createModelBuffer(value, concreteModel.getOptions().defaultEOL);
		try {
			if (concreteModel.equalsTextBuffer(textBuffer)) return;
			const edits = ModelService._computeEdits(concreteModel, textBuffer);
			if (edits.length > 0) {
				concreteModel.applyOperations(edits, { editSource: reason });
			}
			const targetEOL = textBuffer.getEOL() === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF;
			if (concreteModel.getEndOfLineSequence() !== targetEOL) {
				if (edits.length > 0) {
					concreteModel.popStackElement();
				} else {
					concreteModel.pushStackElement();
				}
				concreteModel.pushEOL(targetEOL, reason);
				concreteModel.pushStackElement();
			}
		} finally {
			disposable.dispose();
		}
	}

	destroyModel(resource: URI): void {
		this.getModel(resource)?.dispose();
	}

	getModel(resource: URI): TextModel | null {
		const key = resource.toString();
		return [...this._models].find(([candidate]) => candidate === key)?.[1].model ?? null;
	}

	getModels(): TextModel[] {
		return [...this._models].map(([, modelData]) => modelData.model);
	}

	getCreationOptions(languageIdOrSelection: string | ILanguageSelection, resource: URI | undefined, isForSimpleWidget: boolean): ITextModelCreationOptions {
		const language = typeof languageIdOrSelection === 'string' ? languageIdOrSelection : languageIdOrSelection.languageId;
		const cacheKey = `${language}\0${resource?.toString() ?? ''}\0${isForSimpleWidget ? 'simple' : 'full'}`;
		let options = this._modelCreationOptionsByLanguageAndResource[cacheKey];
		if (!options) {
			const overrides: IConfigurationOverrides = { overrideIdentifier: language, resource };
			options = ModelService._readModelOptions({
				tabSize: this._configurationService.getValue<number>(modelConfiguration.tabSize, overrides),
				indentSize: this._configurationService.getValue<number | 'tabSize'>(modelConfiguration.indentSize, overrides),
				insertSpaces: this._configurationService.getValue<boolean>(modelConfiguration.insertSpaces, overrides),
				detectIndentation: this._configurationService.getValue<boolean>(modelConfiguration.detectIndentation, overrides),
				trimAutoWhitespace: this._configurationService.getValue<boolean>(modelConfiguration.trimAutoWhitespace, overrides),
				largeFileOptimizations: this._configurationService.getValue<boolean>(modelConfiguration.largeFileOptimizations, overrides),
				bracketPairColorizationEnabled: this._configurationService.getValue<boolean>(modelConfiguration.bracketPairColorizationEnabled, overrides),
				bracketPairColorizationIndependentColorPool: this._configurationService.getValue<boolean>(modelConfiguration.bracketPairColorizationIndependentColorPool, overrides),
				eol: this._getEOL(resource, language),
			}, isForSimpleWidget);
			this._modelCreationOptionsByLanguageAndResource[cacheKey] = options;
		}
		return options;
	}

	private static _readModelOptions(config: RawModelConfiguration, isForSimpleWidget: boolean): ITextModelCreationOptions {
		return Object.freeze({
			tabSize: config.tabSize,
			indentSize: config.indentSize,
			insertSpaces: config.insertSpaces,
			detectIndentation: config.detectIndentation,
			trimAutoWhitespace: config.trimAutoWhitespace,
			defaultEOL: config.eol === '\n' ? DefaultEndOfLine.LF : DefaultEndOfLine.CRLF,
			isForSimpleWidget,
			largeFileOptimizations: config.largeFileOptimizations,
			bracketPairColorizationOptions: Object.freeze({
				enabled: config.bracketPairColorizationEnabled,
				independentColorPoolPerBracketType: config.bracketPairColorizationIndependentColorPool,
			}),
		});
	}

	private _getEOL(resource: URI | undefined, language: string): string {
		if (resource) return this._resourcePropertiesService.getEOL(resource, language);
		const configured = this._configurationService.getValue<'auto' | '\n' | '\r\n'>(modelConfiguration.filesEol, { overrideIdentifier: language });
		return configured === 'auto' ? (isLinux || isMacintosh ? '\n' : '\r\n') : configured;
	}

	private _shouldRestoreUndoStack(): boolean {
		return this._configurationService.getValue<boolean>(modelConfiguration.restoreUndoStack);
	}

	private _updateModelOptions(event: IConfigurationChangeEvent): void {
		const oldOptionsByLanguageAndResource = this._modelCreationOptionsByLanguageAndResource;
		this._modelCreationOptionsByLanguageAndResource = Object.create(null) as Record<string, ITextModelCreationOptions>;
		for (const [, modelData] of this._models) {
			const model = modelData.model;
			const overrides = { overrideIdentifier: model.getLanguageId(), resource: model.uri };
			if (!MODEL_CONFIGURATION_KEYS.some(key => event.affectsConfiguration(key, overrides))) continue;
			const cachePrefix = `${model.getLanguageId()}\0${model.uri.toString()}\0`;
			const currentOptions = oldOptionsByLanguageAndResource[`${cachePrefix}${model.isForSimpleWidget ? 'simple' : 'full'}`];
			const newOptions = this.getCreationOptions(model.getLanguageId(), model.uri, model.isForSimpleWidget);
			ModelService._setModelOptionsForModel(model, newOptions, currentOptions);
		}
	}

	private static _setModelOptionsForModel(model: ITextModel, newOptions: ITextModelCreationOptions, currentOptions: ITextModelCreationOptions | undefined): void {
		if (currentOptions && currentOptions.defaultEOL !== newOptions.defaultEOL && model.getLineCount() === 1) {
			model.setEOL(newOptions.defaultEOL === DefaultEndOfLine.LF ? EndOfLineSequence.LF : EndOfLineSequence.CRLF);
		}
		if (currentOptions
			&& currentOptions.detectIndentation === newOptions.detectIndentation
			&& currentOptions.insertSpaces === newOptions.insertSpaces
			&& currentOptions.tabSize === newOptions.tabSize
			&& currentOptions.indentSize === newOptions.indentSize
			&& currentOptions.trimAutoWhitespace === newOptions.trimAutoWhitespace
			&& currentOptions.bracketPairColorizationOptions.enabled === newOptions.bracketPairColorizationOptions.enabled
			&& currentOptions.bracketPairColorizationOptions.independentColorPoolPerBracketType === newOptions.bracketPairColorizationOptions.independentColorPoolPerBracketType) return;
		if (newOptions.detectIndentation) {
			model.detectIndentation(newOptions.insertSpaces, newOptions.tabSize);
			model.updateOptions({
				trimAutoWhitespace: newOptions.trimAutoWhitespace,
				bracketColorizationOptions: newOptions.bracketPairColorizationOptions,
			});
			return;
		}
		model.updateOptions({
			insertSpaces: newOptions.insertSpaces,
			tabSize: newOptions.tabSize,
			indentSize: newOptions.indentSize,
			trimAutoWhitespace: newOptions.trimAutoWhitespace,
			bracketColorizationOptions: newOptions.bracketPairColorizationOptions,
		});
	}

	private _createModelData(model: TextModel, key: string): ModelData {
		return new ModelData(
			model,
			() => this._onWillDispose(key, model),
			oldLanguageId => this._onDidChangeLanguage(model, oldLanguageId),
		);
	}

	private _onDidChangeLanguage(model: TextModel, oldLanguageId: string): void {
		const oldOptions = this.getCreationOptions(oldLanguageId, model.uri, model.isForSimpleWidget);
		this._modelCreationOptionsByLanguageAndResource = Object.create(null) as Record<string, ITextModelCreationOptions>;
		const options = this.getCreationOptions(model.getLanguageId(), model.uri, model.isForSimpleWidget);
		ModelService._setModelOptionsForModel(model, options, oldOptions);
		this._onModelModeChanged.fire(Object.freeze({ model, oldLanguageId }));
	}

	private static _commonPrefix(model: ITextModel, modelLineCount: number, modelLineDelta: number, textBuffer: ITextBuffer, textBufferLineCount: number, textBufferLineDelta: number): number {
		const maximum = Math.min(modelLineCount, textBufferLineCount);
		let result = 0;
		while (result < maximum && model.getLineContent(modelLineDelta + result) === textBuffer.getLineContent(textBufferLineDelta + result)) result += 1;
		return result;
	}

	private static _commonSuffix(model: ITextModel, modelLineCount: number, modelLineDelta: number, textBuffer: ITextBuffer, textBufferLineCount: number, textBufferLineDelta: number): number {
		const maximum = Math.min(modelLineCount, textBufferLineCount);
		let result = 0;
		while (result < maximum && model.getLineContent(modelLineDelta + modelLineCount - result) === textBuffer.getLineContent(textBufferLineDelta + textBufferLineCount - result)) result += 1;
		return result;
	}

	public static _computeEdits(model: ITextModel, textBuffer: ITextBuffer): ISingleEditOperation[] {
		const modelLineCount = model.getLineCount();
		const textBufferLineCount = textBuffer.getLineCount();
		const commonPrefix = this._commonPrefix(model, modelLineCount, 1, textBuffer, textBufferLineCount, 1);
		if (modelLineCount === textBufferLineCount && commonPrefix === modelLineCount) return [];
		const commonSuffix = this._commonSuffix(model, modelLineCount - commonPrefix, commonPrefix, textBuffer, textBufferLineCount - commonPrefix, commonPrefix);
		let oldRange: Range;
		let newRange: Range;
		if (commonSuffix > 0) {
			oldRange = new Range(commonPrefix + 1, 1, modelLineCount - commonSuffix + 1, 1);
			newRange = new Range(commonPrefix + 1, 1, textBufferLineCount - commonSuffix + 1, 1);
		} else if (commonPrefix > 0) {
			oldRange = new Range(commonPrefix, model.getLineMaxColumn(commonPrefix), modelLineCount, model.getLineMaxColumn(modelLineCount));
			newRange = new Range(commonPrefix, textBuffer.getLineMaxColumn(commonPrefix), textBufferLineCount, textBuffer.getLineMaxColumn(textBufferLineCount));
		} else {
			oldRange = new Range(1, 1, modelLineCount, model.getLineMaxColumn(modelLineCount));
			newRange = new Range(1, 1, textBufferLineCount, textBuffer.getLineMaxColumn(textBufferLineCount));
		}
		return [EditOperation.replaceMove(oldRange, textBuffer.getValueInRange(newRange, EndOfLinePreference.TextDefined))];
	}

	private _onWillDispose(key: string, model: TextModel): void {
		const modelData = [...this._models].find(([, candidate]) => candidate.model === model)?.[1];
		if (!modelData || modelData.model.uri.toString() !== key) return;
		const snapshot = model.createUndoRedoSnapshot();
		if (snapshot && snapshot.contentLength <= DefaultModelSHA1Computer.MAX_MODEL_SIZE && this._shouldRestoreUndoStack() && this._schemaShouldMaintainUndoRedoElements(model.uri)) {
			this._insertDisposedModel(new DisposedModelInfo(model.uri, snapshot, Date.now(), snapshot.contentLength + snapshot.history.textUnits, snapshot.contentSHA1));
			this._ensureDisposedModelsHeapSize(ModelService.MAX_MEMORY_FOR_CLOSED_FILES_UNDO_STACK);
		}
		this._onModelRemoved.fire(model);
		this._models.deleteAndDispose(key);
	}

	protected _schemaShouldMaintainUndoRedoElements(resource: URI): boolean {
		return resource.scheme === 'file'
			|| resource.scheme === 'vscode-remote'
			|| resource.scheme === 'vscode-userdata'
			|| resource.scheme === 'vscode-notebook-cell'
			|| resource.scheme === 'fake-fs';
	}

	protected _getSHA1Computer(): ITextModelSHA1Computer {
		return new DefaultModelSHA1Computer();
	}

	private _insertDisposedModel(disposedModel: DisposedModelInfo): void {
		const key = disposedModel.uri.toString();
		const existing = this._disposedModels.get(key);
		if (existing) this._disposedModelsHeapSize -= existing.heapSize;
		this._disposedModels.set(key, disposedModel);
		this._disposedModelsHeapSize += disposedModel.heapSize;
	}

	private _removeDisposedModel(resource: URI): DisposedModelInfo | undefined {
		const key = resource.toString();
		const disposedModel = this._disposedModels.get(key);
		if (!disposedModel) return undefined;
		this._disposedModels.delete(key);
		this._disposedModelsHeapSize -= disposedModel.heapSize;
		return disposedModel;
	}

	private _ensureDisposedModelsHeapSize(maxHeapSize: number): void {
		if (this._disposedModelsHeapSize <= maxHeapSize) return;
		const disposedModels = [...this._disposedModels.values()].sort((left, right) => left.time - right.time);
		for (const disposedModel of disposedModels) {
			if (this._disposedModelsHeapSize <= maxHeapSize) break;
			this._removeDisposedModel(disposedModel.uri);
		}
	}
}

interface RawModelConfiguration {
	readonly tabSize: number;
	readonly indentSize: number | 'tabSize';
	readonly insertSpaces: boolean;
	readonly detectIndentation: boolean;
	readonly trimAutoWhitespace: boolean;
	readonly largeFileOptimizations: boolean;
	readonly bracketPairColorizationEnabled: boolean;
	readonly bracketPairColorizationIndependentColorPool: boolean;
	readonly eol: string;
}

const modelConfiguration = Object.freeze({
	tabSize: 'editor.tabSize',
	indentSize: 'editor.indentSize',
	insertSpaces: 'editor.insertSpaces',
	detectIndentation: 'editor.detectIndentation',
	trimAutoWhitespace: 'editor.trimAutoWhitespace',
	largeFileOptimizations: 'editor.largeFileOptimizations',
	bracketPairColorizationEnabled: 'editor.bracketPairColorization.enabled',
	bracketPairColorizationIndependentColorPool: 'editor.bracketPairColorization.independentColorPoolPerBracketType',
	filesEol: 'files.eol',
	restoreUndoStack: 'files.restoreUndoStack',
});

const MODEL_CONFIGURATION_KEYS: readonly string[] = Object.freeze([
	modelConfiguration.tabSize,
	modelConfiguration.indentSize,
	modelConfiguration.insertSpaces,
	modelConfiguration.detectIndentation,
	modelConfiguration.trimAutoWhitespace,
	modelConfiguration.largeFileOptimizations,
	modelConfiguration.bracketPairColorizationEnabled,
	modelConfiguration.bracketPairColorizationIndependentColorPool,
	modelConfiguration.filesEol,
]);

function isTextBufferFactory(value: unknown): value is ITextBufferFactory {
	return !!value
		&& typeof value === 'object'
		&& typeof (value as ITextBufferFactory).create === 'function'
		&& typeof (value as ITextBufferFactory).getFirstLineText === 'function';
}

function readModelValue(value: string | ITextBufferFactory, defaultEOL: DefaultEndOfLine): string {
	if (typeof value === 'string') return value;
	const result = value.create(defaultEOL);
	try {
		return result.textBuffer.getBOM() + result.textBuffer.createSnapshot().getText();
	} finally {
		result.disposable.dispose();
	}
}

function createModelBuffer(value: string | ITextBufferFactory, defaultEOL: DefaultEndOfLine): { readonly textBuffer: ITextBuffer; readonly disposable: IDisposable } {
	if (typeof value !== 'string') return value.create(defaultEOL);
	const textBuffer = createPieceTreeTextBuffer(value, defaultEOL);
	return { textBuffer, disposable: textBuffer };
}

class ModelData extends Disposable {
	constructor(
		readonly model: TextModel,
		onWillDispose: () => void,
		onDidChangeLanguage: (oldLanguageId: string) => void,
	) {
		super();
		this._register(model.onWillDispose(onWillDispose));
		this._register(model.onDidChangeLanguage(event => onDidChangeLanguage(event.oldLanguage)));
	}
}

class DisposedModelInfo {
	constructor(
		public readonly uri: URI,
		public readonly snapshot: TextModelUndoRedoSnapshot,
		public readonly time: number,
		public readonly heapSize: number,
		public readonly sha1: string,
	) {}
}

export interface ITextModelSHA1Computer {
	canComputeSHA1(model: ITextModel): boolean;
	computeSHA1(model: ITextModel): string;
}

export class DefaultModelSHA1Computer implements ITextModelSHA1Computer {
	static readonly MAX_MODEL_SIZE = 10 * 1024 * 1024;

	canComputeSHA1(model: ITextModel): boolean {
		return model.getValueLength() <= DefaultModelSHA1Computer.MAX_MODEL_SIZE;
	}

	computeSHA1(model: ITextModel): string {
		const sha1 = new StringSHA1();
		const snapshot = model.createSnapshot();
		let chunk: string | null;
		while ((chunk = snapshot.read()) !== null) sha1.update(chunk);
		return sha1.digest();
	}
}
