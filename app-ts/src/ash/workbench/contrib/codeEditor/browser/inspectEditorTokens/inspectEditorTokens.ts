import './inspectEditorTokens.css';
import * as textMate from 'vscode-textmate';
import { h } from '../../../../../base/browser/dom.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize } from '../../../../../nls.js';
import { localizedString } from '../../../../../platform/action/common/action.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { createTextMateScopeThemeResolver } from '../../../../services/textMate/common/textMateScopeTheme.js';
import { ITextMateService } from '../../../../services/textMate/common/textMateService.js';

const initialState = ((textMate as unknown as { default?: typeof textMate }).default ?? textMate).INITIAL;

class InspectEditorTokens extends Action2 {
	constructor() {
		super({ id: 'editor.action.inspectTMScopes', title: localizedString('ash', 'inspectEditorTokens.command', 'Developer: Inspect Editor Tokens and Scopes'), f1: true });
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
		const model = editor?.getModel();
		const position = editor?.getPosition();
		if (!editor || !model || !position) return;
		const version = model.getVersionId();
		const language = model.getLanguageId();
		const lines = Array.from({ length: position.lineNumber }, (_, index) => model.getLineContent(index + 1));
		const textMateService = accessor.get(ITextMateService);
		const grammar = await textMateService.createTokenizer(language);
		if (editor.getModel() !== model || model.getVersionId() !== version || model.getLanguageId() !== language || editor.getPosition()?.equals(position) !== true) return;
		let state = initialState;
		let scopes: readonly string[] = [];
		let text = '';
		if (grammar) {
			for (const [index, line] of lines.entries()) {
				const result = grammar.tokenizeLine(line, state);
				state = result.ruleStack;
				if (index !== lines.length - 1) continue;
				const offset = Math.min(position.column - 1, Math.max(0, line.length - 1));
				const token = result.tokens.find(token => token.startIndex <= offset && offset < token.endIndex);
				if (token) { scopes = token.scopes; text = line.slice(token.startIndex, token.endIndex); }
			}
		}
		const theme = accessor.get(IThemeService).getColorTheme();
		const style = createTextMateScopeThemeResolver(textMateService.scopeTheme.currentTheme)(scopes);
		const report = [
			localize('inspectEditorTokens.position', 'Position: {0}:{1}', position.lineNumber, position.column),
			localize('inspectEditorTokens.language', 'Language: {0}', language),
			localize('inspectEditorTokens.theme', 'Theme: {0}', theme.label),
			localize('inspectEditorTokens.text', 'Token: {0}', JSON.stringify(text)),
			localize('inspectEditorTokens.color', 'Syntax color: {0}', style?.foreground ?? theme.getColorCss('editor.foreground')),
			localize('inspectEditorTokens.font', 'Syntax font style: {0}', style?.fontStyle?.join(' ') || localize('inspectEditorTokens.regular', 'regular')),
			'', localize('inspectEditorTokens.scopes', 'TextMate scopes (outer to inner):'),
			...(scopes.length ? scopes : [localize('inspectEditorTokens.noGrammar', 'No TextMate grammar is registered for this language.')]),
		].join('\n');
		using lifetime = new DisposableStore();
		const root = accessor.get(ILayoutService).mainContainer;
		const content = h(root.ownerDocument, 'textarea');
		content.className = 'ash-inspect-editor-tokens-content';
		content.readOnly = true;
		content.value = report;
		content.setAttribute('aria-label', localize('inspectEditorTokens.report', 'Editor token inspection'));
		const hint = accessor.get(IAccessibleViewService).getOpenAriaHint(AccessibilityVerbositySettingId.InspectEditorTokens);
		if (hint) content.setAttribute('aria-description', hint);
		const dialog = lifetime.add(new Dialog(root, {
			title: localize('inspectEditorTokens.title', 'Editor Tokens and Scopes'), content,
			buttons: [{ label: localize('inspectEditorTokens.close', 'Close'), value: 'close' }], cancelValue: 'close',
		}));
		const context = lifetime.add(accessor.get(IContextKeyService).createScoped(dialog.element));
		context.createKey('inspectEditorTokensVisible', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			lifetime.add(AccessibleViewRegistry.register({
				name: 'inspectEditorTokens', type, priority: 150, when: ContextKeyExpr.has('inspectEditorTokensVisible'),
				getProvider: () => new AccessibleContentProvider(AccessibleViewProviderId.InspectEditorTokens, { type },
					() => type === AccessibleViewType.View ? report : localize('inspectEditorTokens.help', 'This report shows the token at the editor cursor, its syntax color and font style, and its TextMate scope stack. Copy a scope into editor.tokenColorCustomizations.textMateRules to change its style. Use Tab and Shift+Tab to move between the report and Close. Press Escape to return to the editor.'),
					() => content.focus(), AccessibilityVerbositySettingId.InspectEditorTokens),
			}));
		}
		try { await dialog.show(); }
		finally { editor.focus(); }
	}
}

registerAction2(InspectEditorTokens);
