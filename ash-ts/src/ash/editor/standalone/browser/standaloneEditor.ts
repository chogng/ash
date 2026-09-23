import { type IDisposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { ContentWidgetPositionPreference, OverlayWidgetPositionPreference, type ICodeEditor } from "../../browser/editorBrowser.js";
import { type CodeEditorWidgetOptions } from '../../browser/widget/codeEditor/codeEditorWidget.js';
import { PositionAffinity, type ITextModel } from "../../common/model.js";
import { TextModel } from "../../common/model/textModel.js";
import { IStandaloneThemeService, type IStandaloneThemeData, type NamedEditorThemeData } from "../common/standaloneTheme.js";
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';
import { IModelService } from '../../common/services/model.js';
import { ILanguageService } from '../../common/languages/language.js';
import { createTextModel, StandaloneEditor, type IStandaloneCodeEditor, type IStandaloneEditorConstructionOptions } from './standaloneCodeEditor.js';
import { StandaloneServices, type StandaloneServiceOverrides } from "./standaloneServices.js";
import { Colorizer, type IColorizerElementOptions, type IColorizerOptions } from './colorizer.js';
import { IMarkerService, type Marker, type MarkerInput } from '../../../platform/markers/common/markers.js';

export type StandaloneMarkerData = Omit<MarkerInput, 'resource'>;

export interface IStandaloneEditorApi {
	readonly ContentWidgetPositionPreference: typeof ContentWidgetPositionPreference;
	readonly OverlayWidgetPositionPreference: typeof OverlayWidgetPositionPreference;
	readonly PositionAffinity: typeof PositionAffinity;
	readonly create: typeof create;
	readonly createModel: typeof createModel;
	readonly getModel: typeof getModel;
	readonly getModels: typeof getModels;
	readonly setModelLanguage: typeof setModelLanguage;
	readonly setModelMarkers: typeof setModelMarkers;
	readonly removeAllMarkers: typeof removeAllMarkers;
	readonly getModelMarkers: typeof getModelMarkers;
	readonly onDidChangeMarkers: typeof onDidChangeMarkers;
	readonly getEditors: typeof getEditors;
	readonly onDidCreateEditor: typeof onDidCreateEditor;
	readonly onDidCreateModel: typeof onDidCreateModel;
	readonly onWillDisposeModel: typeof onWillDisposeModel;
	readonly onDidChangeModelLanguage: typeof onDidChangeModelLanguage;
	readonly defineNamedTheme: typeof defineNamedTheme;
	readonly defineTheme: typeof defineTheme;
	readonly setTheme: typeof setTheme;
	readonly colorize: typeof colorize;
	readonly colorizeElement: typeof colorizeElement;
}

const contentWidgetPositionPreference = Object.freeze({
	EXACT: ContentWidgetPositionPreference.EXACT,
	ABOVE: ContentWidgetPositionPreference.ABOVE,
	BELOW: ContentWidgetPositionPreference.BELOW,
});
const overlayWidgetPositionPreference = Object.freeze({
	TOP_RIGHT_CORNER: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER,
	BOTTOM_RIGHT_CORNER: OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER,
	TOP_CENTER: OverlayWidgetPositionPreference.TOP_CENTER,
});

export function onDidCreateEditor(listener: (codeEditor: ICodeEditor) => void): IDisposable {
	return StandaloneServices.get(ICodeEditorService).onCodeEditorAdd(listener);
}

export function onDidCreateModel(listener: (model: ITextModel) => void): IDisposable {
	return StandaloneServices.get(IModelService).onModelAdded(listener);
}

export function onWillDisposeModel(listener: (model: ITextModel) => void): IDisposable {
	return StandaloneServices.get(IModelService).onModelRemoved(listener);
}

export function onDidChangeModelLanguage(listener: (event: { readonly model: ITextModel; readonly oldLanguage: string }) => void): IDisposable {
	return StandaloneServices.get(IModelService).onModelLanguageChanged(event => listener({ model: event.model, oldLanguage: event.oldLanguageId }));
}

/** Creates one browser editor. A supplied model must come from createModel(). */
export function create(
	domElement: HTMLElement,
	options: IStandaloneEditorConstructionOptions = {},
	overrides: StandaloneServiceOverrides = {},
): IStandaloneCodeEditor {
	if (!domElement || domElement.nodeType !== 1 || !domElement.ownerDocument) throw new TypeError("Standalone editor requires an HTML element");
	const services = StandaloneServices.initialize(overrides);
	const {
		model: suppliedModel,
		value,
		language,
		resource,
		label,
		readOnly,
		theme,
		autoDetectHighContrast,
		...browserOptions
	} = options;
	if (suppliedModel && (value !== undefined || language !== undefined || resource !== undefined)) {
		throw new TypeError("Standalone editor model cannot be combined with value, language, or resource");
	}
	if (suppliedModel && !(suppliedModel instanceof TextModel)) {
		throw new TypeError('Standalone editor requires a TextModel created by this editor API');
	}
	if (theme !== undefined) services.themeService.setTheme(theme);
	if (autoDetectHighContrast !== undefined) services.themeService.setAutoDetectHighContrast(autoDetectHighContrast);
	const languageId = services.languageService.getLanguageIdByMimeType(language) ?? language;
	const model = suppliedModel === undefined
		? services.modelService.createModel(value ?? "", services.languageService.createById(languageId), resource)
		: suppliedModel;
	const ownsModel = suppliedModel === undefined;
	try {
		if (model && services.modelService.getModel(model.uri) !== model) throw new ReferenceError('Standalone editor model is not registered with the model service');
		const editorOptions: CodeEditorWidgetOptions = {
			...browserOptions,
			container: domElement,
			input: { resource: model?.uri, label, readOnly },
			languageId: model?.getLanguageId() ?? 'plaintext',
			model,
			editorWorkerFactory: services.editorWorkerFactory,
			completionWorkerFactory: services.completionWorkerFactory,
		};
		return services.createInstance(StandaloneEditor, editorOptions, model, ownsModel);
	} catch (error) {
		if (ownsModel) model?.dispose();
		throw error;
	}
}

export function createModel(value: string, language?: string, uri?: URI): ITextModel {
	const services = StandaloneServices.initialize();
	const languageId = services.languageService.getLanguageIdByMimeType(language) || language;
	return createTextModel(services.modelService, services.languageService, value, languageId, uri);
}

export function getModel(uri: URI): ITextModel | null {
	return StandaloneServices.get(IModelService).getModel(uri);
}

export function getModels(): ITextModel[] {
	return StandaloneServices.get(IModelService).getModels();
}

export function setModelLanguage(model: ITextModel, mimeTypeOrLanguageId: string): void {
	const languageService = StandaloneServices.get(ILanguageService);
	const languageId = languageService.getLanguageIdByMimeType(mimeTypeOrLanguageId) ?? (mimeTypeOrLanguageId || 'plaintext');
	model.setLanguage(languageService.createById(languageId));
}

export function setModelMarkers(model: ITextModel, owner: string, markers: readonly StandaloneMarkerData[]): void {
	if (StandaloneServices.get(IModelService).getModel(model.uri) !== model) {
		throw new ReferenceError('Standalone marker model is not registered with the model service');
	}
	StandaloneServices.get(IMarkerService).changeOne(owner, model.uri, markers);
}

export function removeAllMarkers(owner: string): void {
	StandaloneServices.get(IMarkerService).remove(owner);
}

export function getModelMarkers(filter: { readonly owner?: string; readonly resource?: URI; readonly take?: number } = {}): readonly Marker[] {
	const markers = StandaloneServices.get(IMarkerService).read(filter.resource, filter.owner);
	if (filter.take === undefined) return markers;
	if (!Number.isSafeInteger(filter.take) || filter.take < 0) throw new RangeError('Marker take must be a non-negative integer');
	return markers.slice(0, filter.take);
}

export function onDidChangeMarkers(listener: (resources: readonly URI[]) => void): IDisposable {
	return StandaloneServices.get(IMarkerService).onDidChange(event => listener(event.resources));
}

export function getEditors(): readonly ICodeEditor[] {
	return StandaloneServices.get(ICodeEditorService).listCodeEditors();
}

export function defineNamedTheme(themeId: string, themeData: NamedEditorThemeData): void {
	StandaloneServices.get(IStandaloneThemeService).defineNamedTheme(themeId, themeData);
}

export function defineTheme(themeName: string, themeData: IStandaloneThemeData): void {
	StandaloneServices.get(IStandaloneThemeService).defineTheme(themeName, themeData);
}

export function setTheme(themeId: string): void {
	StandaloneServices.get(IStandaloneThemeService).setTheme(themeId);
}

export function colorize(text: string, languageId: string, options: IColorizerOptions = {}): Promise<string> {
	return Colorizer.colorize(StandaloneServices.get(ILanguageService), text, languageId, options);
}

export function colorizeElement(domNode: HTMLElement, options: IColorizerElementOptions = {}): Promise<void> {
	return Colorizer.colorizeElement(StandaloneServices.get(IStandaloneThemeService), StandaloneServices.get(ILanguageService), domNode, options);
}

export function createStandaloneEditorApi(): IStandaloneEditorApi {
	return Object.freeze({
		ContentWidgetPositionPreference: contentWidgetPositionPreference,
		OverlayWidgetPositionPreference: overlayWidgetPositionPreference,
		PositionAffinity,
		create,
		createModel,
		getModel,
		getModels,
		setModelLanguage,
		setModelMarkers,
		removeAllMarkers,
		getModelMarkers,
		onDidChangeMarkers,
		getEditors,
		onDidCreateEditor,
		onDidCreateModel,
		onWillDisposeModel,
		onDidChangeModelLanguage,
		defineNamedTheme,
		defineTheme,
		setTheme,
		colorize,
		colorizeElement,
	});
}

export type { IStandaloneCodeEditor } from './standaloneCodeEditor.js';
