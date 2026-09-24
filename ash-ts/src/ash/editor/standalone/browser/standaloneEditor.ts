import './standalone-tokens.css';
import { DisposableStore, type IDisposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { ContentWidgetPositionPreference, OverlayWidgetPositionPreference, type ICodeEditor } from "../../browser/editorBrowser.js";
import { type CodeEditorWidgetOptions } from '../../browser/widget/codeEditor/codeEditorWidget.js';
import { PositionAffinity, type ITextModel } from "../../common/model.js";
import { TextModel } from "../../common/model/textModel.js";
import { IStandaloneThemeService, type IStandaloneThemeData, type NamedEditorThemeData } from "../common/standaloneTheme.js";
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';
import { IModelService } from '../../common/services/model.js';
import { ILanguageService } from '../../common/languages/language.js';
import { createTextModel, StandaloneEditor, type IActionDescriptor, type IStandaloneCodeEditor, type IStandaloneEditorConstructionOptions } from './standaloneCodeEditor.js';
import { StandaloneServices, type StandaloneServiceOverrides } from "./standaloneServices.js";
import { Colorizer, type IColorizerElementOptions, type IColorizerOptions } from './colorizer.js';
import { IMarkerService, type Marker, type MarkerInput } from '../../../platform/markers/common/markers.js';
import { CommandsRegistry, type CommandHandler } from '../../../platform/commands/common/commands.js';
import { parseContextKeyExpression } from '../../../platform/contextkey/common/contextKeyExpressionParser.js';
import { KeybindingsRegistry } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorAction, EditorCommand, EditorExtensionsRegistry, type ServicesAccessor } from '../../browser/editorExtensions.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { createWebWorker as createStandaloneWebWorker, type MonacoWebWorker } from './standaloneWebWorker.js';
import type { StandaloneWorkerOptions } from './services/standaloneWebWorkerService.js';

export type StandaloneMarkerData = Omit<MarkerInput, 'resource'>;

export interface ICommandDescriptor {
	readonly id: string;
	readonly run: CommandHandler;
}

export interface IKeybindingRule {
	readonly keybinding: number;
	readonly command?: string | null;
	readonly commandArgs?: unknown;
	readonly when?: string | null;
}

export interface IStandaloneEditorApi {
	readonly ContentWidgetPositionPreference: typeof ContentWidgetPositionPreference;
	readonly OverlayWidgetPositionPreference: typeof OverlayWidgetPositionPreference;
	readonly PositionAffinity: typeof PositionAffinity;
	readonly create: typeof create;
	readonly createModel: typeof createModel;
	readonly createWebWorker: typeof createWebWorker;
	readonly getModel: typeof getModel;
	readonly getModels: typeof getModels;
	readonly setModelLanguage: typeof setModelLanguage;
	readonly setModelMarkers: typeof setModelMarkers;
	readonly removeAllMarkers: typeof removeAllMarkers;
	readonly getModelMarkers: typeof getModelMarkers;
	readonly onDidChangeMarkers: typeof onDidChangeMarkers;
	readonly addCommand: typeof addCommand;
	readonly registerCommand: typeof registerCommand;
	readonly addEditorAction: typeof addEditorAction;
	readonly addKeybindingRule: typeof addKeybindingRule;
	readonly addKeybindingRules: typeof addKeybindingRules;
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
			model,
			ariaLabel: label,
			readOnly,
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

export function createWebWorker<T extends object>(options: StandaloneWorkerOptions): MonacoWebWorker<T> {
	return createStandaloneWebWorker<T>(StandaloneServices.get(IModelService), options);
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

export function addCommand(descriptor: ICommandDescriptor): IDisposable {
	if (!descriptor || typeof descriptor.id !== 'string' || typeof descriptor.run !== 'function') {
		throw new TypeError('Standalone command requires an id and run handler');
	}
	return CommandsRegistry.register(descriptor.id, descriptor.run);
}

export function registerCommand(id: string, handler: CommandHandler): IDisposable {
	return CommandsRegistry.register(id, handler);
}

export function addEditorAction(descriptor: IActionDescriptor): IDisposable {
	if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()
		|| typeof descriptor.label !== 'string' || !descriptor.label.trim() || typeof descriptor.run !== 'function') {
		throw new TypeError('Standalone editor action requires an id, label and run handler');
	}
	const precondition = descriptor.precondition === undefined ? undefined : parseContextKeyExpression(descriptor.precondition);
	const keybindingContext = descriptor.keybindingContext === undefined ? undefined : parseContextKeyExpression(descriptor.keybindingContext);
	if (descriptor.keybindings !== undefined && (!Array.isArray(descriptor.keybindings)
		|| descriptor.keybindings.some(keybinding => !Number.isSafeInteger(keybinding) || keybinding <= 0))) {
		throw new TypeError('Editor action keybindings must be encoded keybindings');
	}
	const action = new class extends EditorAction {
		constructor() { super({ id: descriptor.id, label: descriptor.label, alias: descriptor.label, precondition }); }
		override runEditorCommand(accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): void | Promise<void> {
			return this.run(accessor, editor, args);
		}
		run(_accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): void | Promise<void> {
			return descriptor.run(editor, ...(args === undefined ? [] : [args]));
		}
	}();
	const resources = new DisposableStore();
	try {
		resources.add(CommandsRegistry.register(descriptor.id, (accessor, ...args) =>
			EditorCommand.runEditorCommand(accessor, args, precondition, (_editorAccessor, editor, commandArgs) => descriptor.run(editor, ...commandArgs))));
		resources.add(EditorExtensionsRegistry.registerDynamicEditorAction(action));
		if (descriptor.contextMenuGroupId) {
			resources.add(MenusRegistry.appendMenuItem(MenuId.EditorContext, {
				command: { id: descriptor.id, title: descriptor.label },
				when: precondition,
				group: descriptor.contextMenuGroupId,
				order: descriptor.contextMenuOrder ?? 0,
			}));
		}
		for (const keybinding of descriptor.keybindings ?? []) {
			resources.add(KeybindingsRegistry.registerKeybindingRule({
				command: descriptor.id,
				keybinding,
				when: ContextKeyExpr.and(precondition, keybindingContext) ?? undefined,
			}));
		}
		return resources;
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

export function addKeybindingRule(rule: IKeybindingRule): IDisposable {
	return addKeybindingRules([rule]);
}

export function addKeybindingRules(rules: readonly IKeybindingRule[]): IDisposable {
	if (!Array.isArray(rules)) throw new TypeError('Keybinding rules must be an array');
	const registrations = rules.map(rule => {
		if (!rule || !Number.isSafeInteger(rule.keybinding) || rule.keybinding <= 0) {
			throw new TypeError('Keybinding rule requires an encoded keybinding');
		}
		if (rule.command != null && (typeof rule.command !== 'string' || !rule.command.trim())) {
			throw new TypeError('Keybinding command must be a non-empty string');
		}
		return {
			keybinding: rule.keybinding,
			command: rule.command,
			args: rule.commandArgs === undefined ? undefined : [rule.commandArgs],
			when: rule.when == null ? undefined : parseContextKeyExpression(rule.when),
		};
	});
	const resources = new DisposableStore();
	try {
		for (const rule of registrations) {
			resources.add(rule.command == null
				? KeybindingsRegistry.registerKeybindingBlocker({ keybinding: rule.keybinding, when: rule.when })
				: KeybindingsRegistry.registerKeybindingRule({ command: rule.command, keybinding: rule.keybinding, args: rule.args, when: rule.when }));
		}
		return resources;
	} catch (error) {
		resources.dispose();
		throw error;
	}
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
		createWebWorker,
		getModel,
		getModels,
		setModelLanguage,
		setModelMarkers,
		removeAllMarkers,
		getModelMarkers,
		onDidChangeMarkers,
		addCommand,
		registerCommand,
		addEditorAction,
		addKeybindingRule,
		addKeybindingRules,
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
