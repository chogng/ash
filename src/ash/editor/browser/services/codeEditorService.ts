import { type Event } from '../../../base/common/event.js';
import { type IDisposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import { type ITextResourceEditorInput } from '../../../platform/editor/common/editor.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { type ICodeEditor, type IDiffEditor } from '../editorBrowser.js';
import { type IDecorationRenderOptions } from '../../common/editorCommon.js';
import { type IModelDecorationOptions, type ITextModel } from '../../common/model.js';

export const ICodeEditorService = createServiceIdentifier<ICodeEditorService>('codeEditorService');

/** Coordinates editor instances, decorations, model state, and editor opening. */
export interface ICodeEditorService {
	readonly _serviceBrand: undefined;
	readonly onWillCreateCodeEditor: Event<void>;
	readonly onCodeEditorAdd: Event<ICodeEditor>;
	readonly onCodeEditorRemove: Event<ICodeEditor>;
	readonly onWillCreateDiffEditor: Event<void>;
	readonly onDiffEditorAdd: Event<IDiffEditor>;
	readonly onDiffEditorRemove: Event<IDiffEditor>;
	readonly onDidChangeTransientModelProperty: Event<ITextModel>;
	readonly onDecorationTypeRegistered: Event<string>;

	willCreateCodeEditor(): void;
	addCodeEditor(editor: ICodeEditor): void;
	removeCodeEditor(editor: ICodeEditor): void;
	listCodeEditors(): readonly ICodeEditor[];
	willCreateDiffEditor(): void;
	addDiffEditor(editor: IDiffEditor): void;
	removeDiffEditor(editor: IDiffEditor): void;
	listDiffEditors(): readonly IDiffEditor[];
	getFocusedCodeEditor(): ICodeEditor | null;
	getActiveCodeEditor(): ICodeEditor | null;

	registerDecorationType(description: string, key: string, options: IDecorationRenderOptions, parentTypeKey?: string, editor?: ICodeEditor): IDisposable;
	listDecorationTypes(): string[];
	removeDecorationType(key: string): void;
	resolveDecorationOptions(typeKey: string, writable: boolean): IModelDecorationOptions;
	resolveDecorationCSSRules(typeKey: string): CSSRuleList | null;

	setModelProperty(resource: URI, key: string, value: unknown): void;
	getModelProperty(resource: URI, key: string): unknown;
	setTransientModelProperty(model: ITextModel, key: string, value: unknown): void;
	getTransientModelProperty(model: ITextModel, key: string): unknown;
	getTransientModelProperties(model: ITextModel): [string, unknown][] | undefined;

	openCodeEditor(input: ITextResourceEditorInput, source: ICodeEditor | null, sideBySide?: boolean): Promise<ICodeEditor | null>;
	registerCodeEditorOpenHandler(handler: ICodeEditorOpenHandler): IDisposable;
}

export interface ICodeEditorOpenHandler {
	(input: ITextResourceEditorInput, source: ICodeEditor | null, sideBySide?: boolean): Promise<ICodeEditor | null>;
}
