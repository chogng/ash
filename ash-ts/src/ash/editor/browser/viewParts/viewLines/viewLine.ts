import { h, reset, fragment as createFragment } from "../../../../base/browser/dom.js";
import { FastDomNode } from "../../../../base/browser/fastDomNode.js";
import { DomReadingContext } from './domReadingContext.js';
import { RangeUtil } from './rangeUtil.js';
import { type ViewLineOptions } from './viewLineOptions.js';
import { SemanticTokenModifier, SemanticTokenPresentation, type ResolvedSemanticToken, type SemanticTokenSource } from '../../../common/tokens/languageTokens.js';
import { type LanguageToken } from '../../../common/tokens/languageTokens.js';
import { CharacterMapping, DomPosition } from '../../../common/viewLayout/viewLineRenderer.js';
import { InlineDecorationType, type InlineDecoration } from '../../../common/viewModel/inlineDecorations.js';
import { type ViewGpuContext } from '../../gpu/viewGpuContext.js';
import { FloatHorizontalRange, VisibleRanges } from '../../view/renderingContext.js';

/** Owns one reusable virtual-line DOM subtree rendered by ViewLines. */
export class ViewLine {
	public static readonly CLASS_NAME = 'view-line';
	private _renderedViewLine: RenderedViewLine;
	private readonly _viewGpuContext: ViewGpuContext | undefined;
	private _isMaybeInvalid = true;

	constructor(host: HTMLElement, lineIndex: number, private _options: ViewLineOptions, tabSize: number, viewGpuContext?: ViewGpuContext) {
		if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('View line tab size must be a positive safe integer');
		const domNode = new FastDomNode(h(host.ownerDocument, "div"));
		const textElement = h(host.ownerDocument, "span");
		domNode.setClassName(ViewLine.CLASS_NAME);
		domNode.domNode.dataset.lineIndex = String(lineIndex);
		textElement.className = "stanza-editor-line-text";
		domNode.domNode.append(textElement);
		this._viewGpuContext = viewGpuContext;
		this._renderedViewLine = new RenderedViewLine(domNode, textElement, tabSize);
	}

	public getDomNode(): HTMLElement {
		return this._renderedViewLine.domNode.domNode;
	}

	public setDomNode(domNode: HTMLElement): void {
		const textElement = domNode.firstElementChild;
		if (!(textElement instanceof domNode.ownerDocument.defaultView!.HTMLSpanElement)) {
			throw new TypeError('A view line DOM node must own one text span');
		}
		this._renderedViewLine = new RenderedViewLine(new FastDomNode(domNode), textElement, this._renderedViewLine.tabSize);
		this._isMaybeInvalid = true;
	}

	public onOptionsChanged(options: ViewLineOptions): void {
		this._options = options;
		this._isMaybeInvalid = true;
	}

	public onContentChanged(): void {
		this._isMaybeInvalid = true;
		this.resetCachedWidth();
	}

	public onTokensChanged(): void {
		this._isMaybeInvalid = true;
		this.resetCachedWidth();
	}

	public onDecorationsChanged(): void {
		this._isMaybeInvalid = true;
		this.resetCachedWidth();
	}

	public onSelectionChanged(): boolean {
		if (this._options.themeType === 'high-contrast-dark' || this._options.themeType === 'high-contrast-light' || this._options.renderWhitespace === 'selection') {
			this._isMaybeInvalid = true;
			return true;
		}
		return false;
	}

	public renderLine(text: string, tokens: readonly ResolvedSemanticToken[], wrappedTextIndentWidth = 0, inlineDecorations: readonly InlineDecoration[] = [], lineNumber = 1): boolean {
		if (!Number.isFinite(wrappedTextIndentWidth) || wrappedTextIndentWidth < 0) throw new RangeError('View line indent must be finite and non-negative');
		this._renderedViewLine.render(text, tokens, wrappedTextIndentWidth, inlineDecorations, lineNumber);
		this._isMaybeInvalid = false;
		return true;
	}

	public layoutLine(lineHeight: number): void {
		this._renderedViewLine.layout(lineHeight);
	}

	public isRenderedRTL(): boolean {
		return this._renderedViewLine.isRightToLeft();
	}

	public getWidth(context: DomReadingContext | null): number {
		return this._renderedViewLine.getWidth(context);
	}

	public getWidthIsFast(): boolean {
		return this._renderedViewLine.hasCachedWidth;
	}

	public needsMonospaceFontCheck(): boolean {
		return this._options.useMonospaceOptimizations && this._renderedViewLine.canCheckMonospaceAssumptions;
	}

	public monospaceAssumptionsAreValid(): boolean {
		return !this.needsMonospaceFontCheck() || this._renderedViewLine.monospaceAssumptionsAreValid(this._options.spaceWidth);
	}

	public onMonospaceAssumptionsInvalidated(): void {
		this._renderedViewLine.disableMonospaceMeasurement();
		this._isMaybeInvalid = true;
	}

	public getVisibleRangesForRange(_lineNumber: number, startColumn: number, endColumn: number, context: DomReadingContext): VisibleRanges | null {
		const ranges = this._renderedViewLine.getVisibleRanges(startColumn, endColumn, context);
		if (ranges && ranges.length > 0) return new VisibleRanges(false, ranges);
		if (!this._options.useMonospaceOptimizations || this._renderedViewLine.isRightToLeft()) return null;
		const fastRange = this._renderedViewLine.getMonospaceVisibleRange(startColumn, endColumn, this._options.spaceWidth);
		return fastRange ? new VisibleRanges(false, [fastRange]) : null;
	}

	public getColumnOfNodeOffset(spanNode: HTMLElement, offset: number): number {
		return this._renderedViewLine.getColumnOfNodeOffset(spanNode, offset);
	}

	public resetCachedWidth(): void {
		this._renderedViewLine.resetCachedWidth();
	}
}

class RenderedViewLine {
	private characterMapping: CharacterMapping;
	private renderedText = '';
	private wrappedTextIndentWidth = 0;
	private cachedWidth: number | undefined;
	private useMonospaceMeasurement = true;

	constructor(
		readonly domNode: FastDomNode<HTMLElement>,
		private readonly textElement: HTMLSpanElement,
		readonly tabSize: number,
	) {
		this.characterMapping = projectStanzaSemanticTokenLine(this.textElement, '', [], this.tabSize);
	}

	get hasCachedWidth(): boolean {
		return this.cachedWidth !== undefined;
	}

	get canCheckMonospaceAssumptions(): boolean {
		return this.cachedWidth !== undefined && (this.cachedWidth > this.wrappedTextIndentWidth || this.renderedText.length === 0);
	}

	render(text: string, tokens: readonly ResolvedSemanticToken[], wrappedTextIndentWidth: number, inlineDecorations: readonly InlineDecoration[], lineNumber: number): void {
		this.characterMapping = projectStanzaSemanticTokenLine(this.textElement, text, tokens, this.tabSize, inlineDecorations, lineNumber);
		this.textElement.style.marginInlineStart = `${wrappedTextIndentWidth}px`;
		this.renderedText = text;
		this.wrappedTextIndentWidth = wrappedTextIndentWidth;
		this.resetCachedWidth();
	}

	layout(lineHeight: number): void {
		this.domNode.setHeight(lineHeight);
		this.domNode.setLineHeight(lineHeight);
	}

	getVisibleRanges(startColumn: number, endColumn: number, context: DomReadingContext): ReturnType<typeof RangeUtil.readHorizontalRanges> {
		if (!this.hasColumn(startColumn) || !this.hasColumn(endColumn) || endColumn < startColumn) return null;
		const start = this.characterMapping.getDomPosition(startColumn);
		const end = this.characterMapping.getDomPosition(endColumn);
		return RangeUtil.readHorizontalRanges(this.textElement, start.partIndex, start.charIndex, end.partIndex, end.charIndex, context);
	}

	getMonospaceVisibleRange(startColumn: number, endColumn: number, spaceWidth: number): FloatHorizontalRange | null {
		if (!this.useMonospaceMeasurement || !this.hasColumn(startColumn) || !this.hasColumn(endColumn) || endColumn < startColumn) return null;
		const start = this.wrappedTextIndentWidth + this.characterMapping.getHorizontalOffset(startColumn) * spaceWidth;
		const end = this.wrappedTextIndentWidth + this.characterMapping.getHorizontalOffset(endColumn) * spaceWidth;
		return new FloatHorizontalRange(start, Math.max(0, end - start));
	}

	getColumnOfNodeOffset(spanNode: HTMLElement, offset: number): number {
		const partIndex = Array.prototype.indexOf.call(this.textElement.children, spanNode) as number;
		if (partIndex < 0 || !Number.isSafeInteger(offset) || offset < 0) return -1;
		const partLength = spanNode.textContent?.length ?? 0;
		if (offset > partLength) return -1;
		return this.characterMapping.getColumn(new DomPosition(partIndex, offset), partLength);
	}

	isRightToLeft(): boolean {
		return this.textElement.ownerDocument.defaultView?.getComputedStyle(this.textElement).direction === 'rtl';
	}

	getWidth(context: DomReadingContext | null): number {
		if (this.cachedWidth !== undefined) return this.cachedWidth;
		const width = context
			? this.textElement.getBoundingClientRect().width / context.clientRectScale
			: this.textElement.offsetWidth;
		context?.markDidDomLayout();
		this.cachedWidth = this.wrappedTextIndentWidth + Math.max(0, width);
		return this.cachedWidth;
	}

	monospaceAssumptionsAreValid(spaceWidth: number): boolean {
		if (!this.useMonospaceMeasurement || this.cachedWidth === undefined) return true;
		const columns = this.characterMapping.getHorizontalOffset(this.renderedText.length + 1);
		const expected = this.wrappedTextIndentWidth + columns * spaceWidth;
		return Math.abs(expected - this.cachedWidth) <= Math.max(0.5, spaceWidth * 0.1);
	}

	disableMonospaceMeasurement(): void {
		this.useMonospaceMeasurement = false;
		this.resetCachedWidth();
	}

	resetCachedWidth(): void {
		this.cachedWidth = undefined;
	}

	private hasColumn(column: number): boolean {
		return Number.isSafeInteger(column) && column >= 1 && column <= this.renderedText.length + 1;
	}
}

export { SemanticTokenModifier, SemanticTokenPresentation } from '../../../common/tokens/languageTokens.js';
export type { ResolvedSemanticToken, SemanticTokenSource } from '../../../common/tokens/languageTokens.js';

/** Projects one line transactionally while preserving its exact source text. */
export function projectStanzaSemanticTokenLine(
	element: HTMLElement,
	lineText: string,
	tokens: readonly ResolvedSemanticToken[],
	tabSize = 4,
	inlineDecorations: readonly InlineDecoration[] = [],
	lineNumber = 1,
): CharacterMapping {
	validateLineTokens(lineText, tokens);
	if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('Stanza semantic line tab size must be a positive safe integer');
	const ownerDocument = element.ownerDocument;
	const fragment = createFragment(ownerDocument);
	const lineDecorations = inlineDecorations.filter(decoration => decoration.range.startLineNumber <= lineNumber && decoration.range.endLineNumber >= lineNumber);
	const boundaries = [...new Set([0, lineText.length, ...tokens.flatMap(token => [token.startColumn, token.endColumn]), ...lineDecorations.flatMap(decoration => [Math.max(0, decoration.range.startColumn - 1), Math.min(lineText.length, decoration.range.endColumn - 1)])])].sort((left, right) => left - right);
	const characterMapping = new CharacterMapping(lineText.length + 1, Math.max(1, boundaries.length - 1));
	let visibleColumn = 0;
	if (lineText.length === 0) {
		fragment.append(h(ownerDocument, 'span'));
		characterMapping.setColumnInfo(1, 0, 0, 0);
	}
	for (let index = 0; index + 1 < boundaries.length; index += 1) {
		const startColumn = boundaries[index]!;
		const endColumn = boundaries[index + 1]!;
		for (const decoration of lineDecorations) {
			if (decoration.type !== InlineDecorationType.WidthOnly || decoration.range.startColumn - 1 !== startColumn) continue;
			const injectedElement = h(ownerDocument, 'span');
			injectedElement.className = decoration.inlineClassName;
			fragment.append(injectedElement);
		}
		const token = tokens.find(candidate => candidate.startColumn <= startColumn && candidate.endColumn >= endColumn);
		const decorations = lineDecorations.filter(decoration => decoration.type !== InlineDecorationType.WidthOnly && decoration.range.startColumn - 1 <= startColumn && decoration.range.endColumn - 1 >= endColumn);
		const tokenElement = h(ownerDocument, "span");
		if (token || decorations.length > 0) tokenElement.className = "stanza-editor-token";
		if (token?.presentation) tokenElement.classList.add(token.presentation);
		for (const modifier of token?.modifiers ?? []) tokenElement.classList.add(modifier);
		if (token?.syntaxPresentation) applySyntaxPresentation(tokenElement, token.syntaxPresentation);
		for (const decoration of decorations) tokenElement.classList.add(...decoration.inlineClassName.split(/\s+/u).filter(Boolean));
		tokenElement.textContent = lineText.slice(startColumn, endColumn);
		for (let offset = startColumn; offset < endColumn; offset += 1) {
			characterMapping.setColumnInfo(offset + 1, index, offset - startColumn, visibleColumn);
			visibleColumn += lineText.charCodeAt(offset) === 9 ? tabSize - visibleColumn % tabSize : 1;
		}
		if (endColumn === lineText.length) characterMapping.setColumnInfo(lineText.length + 1, index, endColumn - startColumn, visibleColumn);
		fragment.append(tokenElement);
	}
	if (fragment.textContent !== lineText) {
		throw new Error("Stanza semantic token projection changed line text");
	}
	reset(element, fragment);
	return characterMapping;
}

/** Captures and validates one source before a viewport replaces its snapshot. */
export function snapshotStanzaSemanticTokenLines(source: SemanticTokenSource): ReadonlyMap<number, readonly ResolvedSemanticToken[]> {
	const result = new Map<number, readonly ResolvedSemanticToken[]>();
	for (const line of source.lines) {
		if (!Number.isSafeInteger(line.lineIndex) || line.lineIndex < 0) {
			throw new RangeError("Stanza semantic token line index must be a non-negative safe integer");
		}
		if (result.has(line.lineIndex)) {
			throw new RangeError(`Duplicate Stanza semantic token line ${line.lineIndex}`);
		}
		const tokens = Object.freeze(line.tokens.map(token => Object.freeze({
			startColumn: token.startColumn,
			endColumn: token.endColumn,
			presentation: token.presentation,
			...(token.modifiers && token.modifiers.length > 0 ? { modifiers: Object.freeze([...token.modifiers]) } : {}),
			...(token.syntaxPresentation === undefined ? {} : { syntaxPresentation: token.syntaxPresentation }),
		})));
		validateLineTokens(source.textModel.getLineContent((line.lineIndex) + 1), tokens);
		result.set(line.lineIndex, tokens);
	}
	return result;
}

function validateLineTokens(lineText: string, tokens: readonly ResolvedSemanticToken[]): void {
	let previousEnd = 0;
	for (const token of tokens) {
		if (token.presentation !== undefined) validatePresentation(token.presentation);
		validateModifiers(token.modifiers);
		if (!Number.isSafeInteger(token.startColumn) || !Number.isSafeInteger(token.endColumn)) {
			throw new RangeError("Stanza semantic token columns must be safe integers");
		}
		if (token.startColumn < previousEnd || token.endColumn <= token.startColumn) {
			throw new RangeError("Stanza semantic tokens must be sorted, non-overlapping, and non-empty");
		}
		if (token.endColumn > lineText.length) {
			throw new RangeError("Stanza semantic token exceeds its line text");
		}
		previousEnd = token.endColumn;
	}
}

function validatePresentation(presentation: SemanticTokenPresentation): void {
	if (!Object.values(SemanticTokenPresentation).includes(presentation)) {
		throw new TypeError(`Unknown Stanza semantic token presentation '${presentation}'`);
	}
}

function validateModifiers(modifiers: readonly SemanticTokenModifier[] | undefined): void {
	if (modifiers === undefined) return;
	if (new Set(modifiers).size !== modifiers.length || modifiers.some(modifier => !Object.values(SemanticTokenModifier).includes(modifier))) {
		throw new TypeError("Unknown or duplicate Stanza semantic token modifier");
	}
}

function applySyntaxPresentation(element: HTMLElement, presentation: NonNullable<LanguageToken["presentation"]>): void {
	if (presentation.foreground !== undefined) {
		element.style.setProperty('--ash-editor-token-foreground', presentation.foreground);
	}
	if (presentation.background !== undefined) element.style.backgroundColor = presentation.background;
	if (presentation.fontStyle?.includes("italic")) element.style.fontStyle = "italic";
	if (presentation.fontStyle?.includes("bold")) element.style.fontWeight = "bold";
	const decorations = presentation.fontStyle?.filter(style => style === "underline" || style === "strikethrough").map(style => style === "strikethrough" ? "line-through" : style) ?? [];
	if (decorations.length > 0) element.style.textDecorationLine = decorations.join(" ");
}
