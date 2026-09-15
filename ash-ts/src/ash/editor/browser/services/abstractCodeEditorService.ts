import { h } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { AbstractDisposable, Disposable, DisposableMap, toDisposable } from '../../../base/common/lifecycle.js';
import { LinkedList } from '../../../base/common/linkedList.js';
import { type URI } from '../../../base/common/uri.js';
import { type ITextResourceEditorInput } from '../../../platform/editor/common/editor.js';
import { type ICodeEditor, type IDiffEditor } from '../editorBrowser.js';
import { isThemeColor, type IDecorationRenderOptions, type IThemeDecorationRenderOptions } from '../../common/editorCommon.js';
import { OverviewRulerLane, type IModelDecorationOptions, type InjectedTextOptions, type ITextModel } from '../../common/model.js';
import { type ICodeEditorOpenHandler, type ICodeEditorService } from './codeEditorService.js';

/** Owns editor discovery and the state shared by all code editor instances. */
export abstract class AbstractCodeEditorService extends Disposable implements ICodeEditorService {
	declare readonly _serviceBrand: undefined;

	private readonly willCreateCodeEditorEmitter = this._register(new Emitter<void>());
	private readonly codeEditorAddEmitter = this._register(new Emitter<ICodeEditor>());
	private readonly codeEditorRemoveEmitter = this._register(new Emitter<ICodeEditor>());
	private readonly willCreateDiffEditorEmitter = this._register(new Emitter<void>());
	private readonly diffEditorAddEmitter = this._register(new Emitter<IDiffEditor>());
	private readonly diffEditorRemoveEmitter = this._register(new Emitter<IDiffEditor>());
	private readonly transientChangeEmitter = this._register(new Emitter<ITextModel>());
	private readonly decorationRegisteredEmitter = this._register(new Emitter<string>());
	private readonly codeEditors = new Map<string, ICodeEditor>();
	private readonly diffEditors = new Map<string, IDiffEditor>();
	private readonly openHandlers = new LinkedList<ICodeEditorOpenHandler>();
	private readonly decorations = this._register(new DisposableMap<string, DecorationRegistration>());
	private readonly modelProperties = new Map<string, Map<string, unknown>>();
	private readonly transientWatchers = this._register(new DisposableMap<string, ModelTransientSettingWatcher>());

	readonly onWillCreateCodeEditor = this.willCreateCodeEditorEmitter.event;
	readonly onCodeEditorAdd = this.codeEditorAddEmitter.event;
	readonly onCodeEditorRemove = this.codeEditorRemoveEmitter.event;
	readonly onWillCreateDiffEditor = this.willCreateDiffEditorEmitter.event;
	readonly onDiffEditorAdd = this.diffEditorAddEmitter.event;
	readonly onDiffEditorRemove = this.diffEditorRemoveEmitter.event;
	readonly onDidChangeTransientModelProperty = this.transientChangeEmitter.event;
	readonly onDecorationTypeRegistered = this.decorationRegisteredEmitter.event;

	willCreateCodeEditor(): void {
		this.willCreateCodeEditorEmitter.fire();
	}

	addCodeEditor(editor: ICodeEditor): void {
		this.codeEditors.set(editor.getId(), editor);
		this.codeEditorAddEmitter.fire(editor);
	}

	removeCodeEditor(editor: ICodeEditor): void {
		if (!this.codeEditors.delete(editor.getId())) {
			return;
		}
		this.codeEditorRemoveEmitter.fire(editor);
	}

	listCodeEditors(): readonly ICodeEditor[] {
		return [...this.codeEditors.values()];
	}

	willCreateDiffEditor(): void {
		this.willCreateDiffEditorEmitter.fire();
	}

	addDiffEditor(editor: IDiffEditor): void {
		this.diffEditors.set(editor.getId(), editor);
		this.diffEditorAddEmitter.fire(editor);
	}

	removeDiffEditor(editor: IDiffEditor): void {
		if (this.diffEditors.delete(editor.getId())) {
			this.diffEditorRemoveEmitter.fire(editor);
		}
	}

	listDiffEditors(): readonly IDiffEditor[] {
		return [...this.diffEditors.values()];
	}

	getFocusedCodeEditor(): ICodeEditor | null {
		let widget: ICodeEditor | null = null;
		for (const editor of this.codeEditors.values()) {
			if (editor.hasTextFocus()) {
				return editor;
			}
			if (editor.hasWidgetFocus()) {
				widget = editor;
			}
		}
		return widget;
	}

	abstract getActiveCodeEditor(): ICodeEditor | null;

	registerDecorationType(description: string, key: string, options: IDecorationRenderOptions, parentKey?: string, editor?: ICodeEditor) {
		const current = this.getDecoration(key);
		if (current) {
			current.refs++;
			return toDisposable(() => this.removeDecorationType(key));
		}

		const parent = parentKey ? this.resolveDecorationOptions(parentKey, true) : undefined;
		this.decorations.set(key, new DecorationRegistration(description, key, options, parent, editor, parentKey, candidate => this.resolveDecorationOptions(candidate, false)));
		this.decorationRegisteredEmitter.fire(key);
		return toDisposable(() => this.removeDecorationType(key));
	}

	listDecorationTypes(): string[] {
		return [...this.decorations.keys()];
	}

	removeDecorationType(key: string): void {
		const decoration = this.getDecoration(key);
		if (!decoration || --decoration.refs > 0) {
			return;
		}
		this.decorations.deleteAndDispose(key);
		for (const editor of this.codeEditors.values()) {
			editor.removeDecorationsByType(key);
		}
	}

	resolveDecorationOptions(key: string, writable: boolean): IModelDecorationOptions {
		const decoration = this.getDecoration(key);
		if (!decoration) {
			throw new Error(`Unknown decoration type: ${key}`);
		}
		return decoration.getOptions(writable);
	}

	resolveDecorationCSSRules(key: string): CSSRuleList | null {
		return this.getDecoration(key)?.cssRules ?? null;
	}

	setModelProperty(resource: URI, key: string, value: unknown): void {
		setValue(this.modelProperties, resource.toString(), key, value);
	}

	getModelProperty(resource: URI, key: string): unknown {
		return this.modelProperties.get(resource.toString())?.get(key);
	}

	setTransientModelProperty(model: ITextModel, key: string, value: unknown): void {
		const uri = model.uri.toString();
		let watcher = this.getTransientWatcher(uri);
		if (!watcher) {
			watcher = this.transientWatchers.set(uri, new ModelTransientSettingWatcher(uri, model, this));
		}
		if (watcher.get(key) === value) {
			return;
		}
		watcher.set(key, value);
		this.transientChangeEmitter.fire(model);
	}

	getTransientModelProperty(model: ITextModel, key: string): unknown {
		return this.getTransientWatcher(model.uri.toString())?.get(key);
	}

	getTransientModelProperties(model: ITextModel): [string, unknown][] | undefined {
		return this.getTransientWatcher(model.uri.toString())?.entries();
	}

	async openCodeEditor(input: ITextResourceEditorInput, source: ICodeEditor | null, sideBySide?: boolean): Promise<ICodeEditor | null> {
		for (const handler of this.openHandlers) {
			const editor = await handler(input, source, sideBySide);
			if (editor !== null) {
				return editor;
			}
		}
		return null;
	}

	registerCodeEditorOpenHandler(handler: ICodeEditorOpenHandler) {
		return toDisposable(this.openHandlers.unshift(handler));
	}

	removeTransientWatcher(watcher: ModelTransientSettingWatcher): void {
		if (this.getTransientWatcher(watcher.uri) === watcher) {
			this.transientWatchers.deleteAndDispose(watcher.uri);
		}
	}

	private getTransientWatcher(uri: string): ModelTransientSettingWatcher | undefined {
		for (const [key, watcher] of this.transientWatchers) {
			if (key === uri) {
				return watcher;
			}
		}
		return undefined;
	}

	private getDecoration(key: string): DecorationRegistration | undefined {
		for (const [candidate, decoration] of this.decorations) {
			if (candidate === key) {
				return decoration;
			}
		}
		return undefined;
	}
}

class DecorationRegistration extends AbstractDisposable {
	readonly cssRules: CSSRuleList | null;
	refs = 1;
	private readonly modelOptions: IModelDecorationOptions;
	private readonly style: HTMLStyleElement | undefined;

	constructor(description: string, key: string, options: IDecorationRenderOptions, parent: IModelDecorationOptions | undefined, editor: ICodeEditor | undefined, private readonly parentKey: string | undefined, private readonly resolveParent: (key: string) => IModelDecorationOptions) {
		super();
		const rendered = renderDecoration(description, key, options, parent);
		this.modelOptions = rendered.options;
		this.style = createStyle(editor);
		if (this.style && rendered.rules.length > 0) {
			this.style.textContent = rendered.rules.join('\n');
		}
		this.cssRules = this.style?.sheet?.cssRules ?? null;
	}

	getOptions(writable: boolean): IModelDecorationOptions {
		let options = this.modelOptions;
		if (this.parentKey) {
			const parent = this.resolveParent(this.parentKey);
			options = {
				...parent,
				...(this.modelOptions.beforeContentClassName ? { beforeContentClassName: this.modelOptions.beforeContentClassName } : {}),
				...(this.modelOptions.afterContentClassName ? { afterContentClassName: this.modelOptions.afterContentClassName } : {}),
			};
		}
		return writable ? { ...options } : options;
	}

	protected override disposeCore(): void {
		this.style?.remove();
	}
}

export class ModelTransientSettingWatcher extends Disposable {
	private readonly values = new Map<string, unknown>();

	constructor(readonly uri: string, model: ITextModel, owner: AbstractCodeEditorService) {
		super();
		this._register(model.onWillDispose(() => owner.removeTransientWatcher(this)));
	}

	set(key: string, value: unknown): void {
		this.values.set(key, value);
	}

	get(key: string): unknown {
		return this.values.get(key);
	}

	entries(): [string, unknown][] {
		return [...this.values];
	}
}

function setValue(store: Map<string, Map<string, unknown>>, id: string, key: string, value: unknown): void {
	let values = store.get(id);
	if (!values) {
		values = new Map();
		store.set(id, values);
	}
	values.set(key, value);
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function createStyle(editor?: ICodeEditor): HTMLStyleElement | undefined {
	if (typeof document === 'undefined') {
		return undefined;
	}
	const style = h(document, 'style');
	const root = editor?.getContainerDomNode().getRootNode();
	if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
		root.appendChild(style);
	} else {
		document.head.appendChild(style);
	}
	return style;
}

function renderDecoration(description: string, key: string, options: IDecorationRenderOptions, parent: IModelDecorationOptions | undefined): { options: IModelDecorationOptions; rules: string[] } {
	const name = `ash-decoration-${safeName(key)}`;
	const rules: string[] = [];
	if (parent) {
		const beforeContentClassName = renderClass(rules, `${name}-before`, options, 'content', '::before');
		const afterContentClassName = renderClass(rules, `${name}-after`, options, 'contentAfter', '::after');
		return {
			options: {
				description: parent.description,
				beforeContentClassName,
				afterContentClassName,
			},
			rules,
		};
	}

	const modelOptions: IModelDecorationOptions = {
		description,
		className: renderClass(rules, name, options, 'line'),
		inlineClassName: renderClass(rules, `${name}-inline`, options, 'inline'),
		glyphMarginClassName: renderClass(rules, `${name}-glyph`, options, 'glyph'),
		beforeContentClassName: renderClass(rules, `${name}-before`, options, 'content', '::before'),
		afterContentClassName: renderClass(rules, `${name}-after`, options, 'contentAfter', '::after'),
		isWholeLine: Boolean(options.isWholeLine),
		lineHeight: options.lineHeight,
		fontFamily: options.fontFamily,
		fontSize: options.fontSize,
		fontWeight: options.fontWeight,
		fontStyle: options.fontStyle,
		stickiness: options.rangeBehavior,
		overviewRuler: options.overviewRulerColor ? {
			color: options.overviewRulerColor,
			position: options.overviewRulerLane ?? OverviewRulerLane.Center,
		} : undefined,
	};
	const before = renderInjectedText(rules, `${name}-before-injected`, options.beforeInjectedText, options.light?.beforeInjectedText, options.dark?.beforeInjectedText);
	const after = renderInjectedText(rules, `${name}-after-injected`, options.afterInjectedText, options.light?.afterInjectedText, options.dark?.afterInjectedText);
	if (before) {
		modelOptions.before = before;
	}
	if (after) {
		modelOptions.after = after;
	}
	return { options: modelOptions, rules };
}

type DecorationRuleKind = 'line' | 'inline' | 'glyph' | 'content' | 'contentAfter';

function renderClass(rules: string[], className: string, options: IDecorationRenderOptions, kind: DecorationRuleKind, pseudo = ''): string | undefined {
	const base = decorationCss(kind, kind === 'contentAfter' ? options.after : kind === 'content' ? options.before : options);
	const light = decorationCss(kind, kind === 'contentAfter' ? options.light?.after : kind === 'content' ? options.light?.before : options.light);
	const dark = decorationCss(kind, kind === 'contentAfter' ? options.dark?.after : kind === 'content' ? options.dark?.before : options.dark);
	if (!base && !light && !dark) {
		return undefined;
	}
	const selector = `.stanza-editor .${className}${pseudo}`;
	if (base) {
		rules.push(`${selector}{${base}}`);
	}
	if (light) {
		rules.push(`.vs ${selector},.hc-light ${selector}{${light}}`);
	}
	if (dark) {
		rules.push(`.vs-dark ${selector},.hc-black ${selector}{${dark}}`);
	}
	return className;
}

function renderInjectedText(rules: string[], className: string, options: IThemeDecorationRenderOptions['beforeInjectedText'], light: IThemeDecorationRenderOptions['beforeInjectedText'], dark: IThemeDecorationRenderOptions['beforeInjectedText']): InjectedTextOptions | undefined {
	if (!options?.contentText) {
		return undefined;
	}
	const renderOptions: IDecorationRenderOptions = {
		...options,
		light,
		dark,
	};
	const inlineClassName = renderClass(rules, className, renderOptions, 'inline');
	return {
		content: firstLine(options.contentText),
		inlineClassName,
		inlineClassNameAffectsLetterSpacing: Boolean(options.affectsLetterSpacing),
	};
}

type DecorationCssOptions = Partial<IThemeDecorationRenderOptions & import('../../common/editorCommon.js').IContentDecorationRenderOptions>;

function decorationCss(kind: DecorationRuleKind, options: DecorationCssOptions | undefined): string {
	if (!options) {
		return '';
	}
	const css: string[] = [];
	if (kind === 'line') {
		addCss(css, 'background-color', options.backgroundColor);
		addBoxCss(css, options);
		addCss(css, 'outline', options.outline);
		addCss(css, 'outline-color', options.outlineColor);
		addCss(css, 'outline-style', options.outlineStyle);
		addCss(css, 'outline-width', options.outlineWidth);
	} else if (kind === 'inline') {
		addTextCss(css, options);
	} else if (kind === 'glyph') {
		if (options.gutterIconPath) {
			const path = uriComponentsToString(options.gutterIconPath).replace(/["\\]/g, '\\$&');
			css.push(`background:url("${path}") center center no-repeat`);
		}
		addCss(css, 'background-size', options.gutterIconSize);
	} else {
		addBoxCss(css, options);
		addTextCss(css, options);
		if (options.contentIconPath) {
			const path = uriComponentsToString(options.contentIconPath).replace(/["\\]/g, '\\$&');
			css.push(`content:url("${path}")`);
		} else if (options.contentText !== undefined) {
			css.push(`content:${JSON.stringify(firstLine(options.contentText))}`);
		}
		addCss(css, 'vertical-align', options.verticalAlign);
		addCss(css, 'margin', options.margin);
		addCss(css, 'padding', options.padding);
		addCss(css, 'width', options.width);
		addCss(css, 'height', options.height);
		if (options.width !== undefined || options.height !== undefined) {
			css.push('display:inline-block');
		}
	}
	return css.join(';');
}

function addBoxCss(css: string[], options: DecorationCssOptions): void {
	addCss(css, 'border', options.border);
	addCss(css, 'border-color', options.borderColor);
	addCss(css, 'border-radius', options.borderRadius);
	addCss(css, 'border-spacing', options.borderSpacing);
	addCss(css, 'border-style', options.borderStyle);
	addCss(css, 'border-width', options.borderWidth);
}

function addTextCss(css: string[], options: DecorationCssOptions): void {
	addCss(css, 'font-family', options.fontFamily);
	addCss(css, 'font-size', options.fontSize);
	addCss(css, 'font-style', options.fontStyle);
	addCss(css, 'font-weight', options.fontWeight);
	addCss(css, 'text-decoration', options.textDecoration);
	addCss(css, 'cursor', options.cursor);
	addCss(css, 'color', options.color);
	addCss(css, 'opacity', options.opacity);
	addCss(css, 'letter-spacing', options.letterSpacing);
}

function firstLine(value: string): string {
	return value.split(/\r?\n/, 1)[0];
}

function uriComponentsToString(value: import('../../../base/common/uri.js').UriComponents): string {
	const authority = value.authority === undefined ? '' : `//${value.authority}`;
	const query = value.query ? `?${value.query}` : '';
	const fragment = value.fragment ? `#${value.fragment}` : '';
	return `${value.scheme}:${authority}${value.path ?? ''}${query}${fragment}`;
}

function addCss(target: string[], name: string, value: string | number | { id: string } | undefined): void {
	if (value === undefined) {
		return;
	}
	const text = isThemeColor(value) ? `var(--vscode-${value.id.replace(/\./g, '-')})` : String(value);
	target.push(`${name}:${text}`);
}
