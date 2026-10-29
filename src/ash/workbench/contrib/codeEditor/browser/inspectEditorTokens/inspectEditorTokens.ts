import { defaultDialogStyles, defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { localize2, localize } from '../../../../../nls.js';
import './inspectEditorTokens.css';
import { h } from '../../../../../base/browser/dom.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';

import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';

class InspectEditorTokens extends Action2 {
	constructor() {
		super({
			id: 'editor.action.inspectTMScopes',
			title: localize2({ bundle: 'ash', key: 'inspectEditorTokens.command' }, 'Developer: Inspect Editor Tokens'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
		const model = editor?.getModel();
		const position = editor?.getPosition();
		if (!editor || !model || !position) return;
		// Service accessors expire as soon as the command handler yields.
		const themes = accessor.get(IThemeService);
		const layout = accessor.get(ILayoutService);
		const contextKeys = accessor.get(IContextKeyService);
		const accessibleViews = accessor.get(IAccessibleViewService);
		const version = model.getVersionId();
		const language = model.getLanguageId();
		using lifetime = new DisposableStore();
		const controller = new AbortController();
		lifetime.add(model.onWillDispose(() => controller.abort()));
		lifetime.add(model.onDidChangeContent(() => controller.abort()));
		lifetime.add(model.onDidChangeLanguage(() => controller.abort()));
		lifetime.add(editor.onDidChangeModel(() => controller.abort()));
		const tree = model.tokenization.syntaxTree;
		try {
			tree?.refreshRange(position.lineNumber, position.lineNumber);
			if (tree) await tree.whenReady(controller.signal);
		} catch (error) {
			if (controller.signal.aborted || model.tokenization.syntaxTree !== tree) return;
			throw error;
		}
		if (controller.signal.aborted || model.tokenization.syntaxTree !== tree) return;
		if (editor.getModel() !== model || model.getVersionId() !== version || model.getLanguageId() !== language || editor.getPosition()?.equals(position) !== true) return;
		const offset = Math.min(position.column - 1, Math.max(0, model.getLineLength(position.lineNumber) - 1));
		const captures = tree?.getTokenCaptures(position.lineNumber).filter(token => token.start <= offset && offset < token.end) ?? [];
		const token = captures.at(-1);
		const text = token ? model.getLineContent(position.lineNumber).slice(token.start, token.end) : '';
		const style = tree
			?.getLanguageTokens(position.lineNumber)
			.filter(token => token.range.startColumn <= offset + 1 && offset + 1 < token.range.endColumn)
			.at(-1)?.presentation;
		const theme = themes.getColorTheme();
		const report = [
			localize('inspectEditorTokens.position', 'Position: {0}:{1}', position.lineNumber, position.column),
			localize('inspectEditorTokens.language', 'Language: {0}', language),
			...(token?.languageId && token.languageId !== language ? [localize('inspectEditorTokens.embeddedLanguage', 'Embedded language: {0}', token.languageId)] : []),
			...(tree ? [localize('inspectEditorTokens.engine', 'Syntax engine: {0}', tree.execution === 'rust' ? 'Tree-sitter / Rust' : 'Tree-sitter / WASM')] : []),
			localize('inspectEditorTokens.theme', 'Theme: {0}', theme.label),
			localize('inspectEditorTokens.text', 'Token: {0}', JSON.stringify(text)),
			localize('inspectEditorTokens.color', 'Syntax color: {0}', style?.foreground ?? theme.getColorCss('editor.foreground')),
			localize('inspectEditorTokens.font', 'Syntax font style: {0}', style?.fontStyle?.join(' ') || localize('inspectEditorTokens.regular', 'regular')),
			'',
			localize('inspectEditorTokens.captures', 'Tree-sitter captures:'),
			...(captures.length ? captures.map(capture => capture.name) : [localize('inspectEditorTokens.noCaptures', 'No Tree-sitter capture at this position.')]),
		].join('\n');
		const root = layout.mainContainer;
		const content = h(root.ownerDocument, 'textarea');
		content.className = 'ash-inspect-editor-tokens-content';
		content.readOnly = true;
		content.value = report;
		content.setAttribute('aria-label', localize('inspectEditorTokens.report', 'Editor token inspection'));
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.InspectEditorTokens);
		if (hint) content.setAttribute('aria-description', hint);
		const dialog = lifetime.add(
			new Dialog(root, localize('inspectEditorTokens.title', 'Editor Tokens'), [localize('inspectEditorTokens.close', 'Close')], {
				buttonStyles: defaultButtonStyles,
				dialogStyles: defaultDialogStyles,
				checkboxStyles: defaultCheckboxStyles,
				inputBoxStyles: defaultInputBoxStyles,
				renderBody: body => {
					body.append(content);
					// Keep the feature's help available when its standard footer action receives focus.
					lifetime.add(contextKeys.createScoped(body)).createKey('inspectEditorTokensVisible', true);
				},
				cancelId: 0,
			}),
		);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			lifetime.add(
				AccessibleViewRegistry.register({
					name: 'inspectEditorTokens',
					type,
					priority: 150,
					when: ContextKeyExpr.has('inspectEditorTokensVisible'),
					getProvider: () =>
						new AccessibleContentProvider(
							AccessibleViewProviderId.InspectEditorTokens,
							{ type },
							() =>
								type === AccessibleViewType.View
									? report
									: localize(
											'inspectEditorTokens.help',
											'This report shows the token at the editor cursor, its syntax color and font style, and its Tree-sitter captures. Use a capture name in editor.semanticTokenColorCustomizations.rules to change its style. Use Tab and Shift+Tab to move between the report and Close. Press Escape to return to the editor.',
										),
							() => content.focus(),
							AccessibilityVerbositySettingId.InspectEditorTokens,
						),
				}),
			);
		}
		try {
			await dialog.show();
		} finally {
			editor.focus();
		}
	}
}

registerAction2(InspectEditorTokens);
