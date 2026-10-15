import { getActiveDocument, getActiveWindow } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import './media/decorationCssRuleExtractor.css';

export class DecorationCssRuleExtractor extends Disposable {
	private _dom: { readonly container: HTMLElement; readonly dummyElement: HTMLSpanElement; } | undefined;
	private _ruleCache: Map</* className */string, CSSStyleRule[]> = new Map();
	private _cssVariableCache: Map</* variableName */string, /* value */string> = new Map();

	constructor() {
		super();
		this._register(toDisposable(() => this._dom?.container.remove()));
	}

	private _getDom(canvas: HTMLElement) {
		if (!this._dom) {
			// The shared extractor can load before browser bootstrap. Its probe belongs to the first canvas that uses it.
			const container = canvas.ownerDocument.createElement('div');
			container.className = 'stanza-decoration-style-probe';
			const dummyElement = canvas.ownerDocument.createElement('span');
			container.appendChild(dummyElement);
			this._dom = { container, dummyElement };
		}
		return this._dom;
	}

	getStyleRules(canvas: HTMLElement, decorationClassName: string): CSSStyleRule[] {
		const existing = this._ruleCache.get(decorationClassName);
		if (existing) return existing;
		const { container, dummyElement } = this._getDom(canvas);
		dummyElement.className = decorationClassName;
		canvas.appendChild(container);
		const rules = this._getStyleRules(decorationClassName);
		this._ruleCache.set(decorationClassName, rules);
		canvas.removeChild(container);
		return rules;
	}

	private _getStyleRules(className: string) {
		const rules: CSSStyleRule[] = [];
		const stylesheets = [...getActiveDocument().styleSheets];
		const classNames = className.split(' ').filter(c => c.length > 0);
		for (const stylesheet of stylesheets) {
			this._collectMatchingRules(stylesheet.cssRules, classNames, rules);
		}
		return rules;
	}

	private _collectMatchingRules(cssRules: CSSRuleList, classNames: string[], result: CSSStyleRule[]): void {
		for (const rule of cssRules) {
			if (rule instanceof CSSImportRule) {
				if (rule.styleSheet) this._collectMatchingRules(rule.styleSheet.cssRules, classNames, result);
			} else if (rule instanceof CSSStyleRule) {
				for (const className of classNames) {
					const searchTerm = `.${className}`;
					const index = rule.selectorText.indexOf(searchTerm);
					if (index !== -1) {
						const endOfResult = index + searchTerm.length;
						if (rule.selectorText.length === endOfResult || rule.selectorText.substring(endOfResult, endOfResult + 1).match(/[ :.]/)) {
							result.push(rule);
							break;
						}
					}
				}
				if (rule.cssRules?.length) this._collectMatchingRules(rule.cssRules, classNames, result);
			}
		}
	}

	resolveCssVariable(canvas: HTMLCanvasElement, variableName: string): string {
		let result = this._cssVariableCache.get(variableName);
		if (result === undefined) {
			const { container } = this._getDom(canvas);
			canvas.appendChild(container);
			result = getActiveWindow().getComputedStyle(container).getPropertyValue(variableName).trim();
			canvas.removeChild(container);
			this._cssVariableCache.set(variableName, result);
		}
		return result;
	}

	clear(): void {
		this._ruleCache.clear();
		this._cssVariableCache.clear();
	}
}
