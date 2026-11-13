import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { resolveSemanticTokenPresentation } from '../../../../editor/common/services/semanticTokensStyling.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import type { CodeImageSnapshot } from '../common/imageEditorService.js';

export async function readCodeImageSelection(editor: ICodeEditor | null, theme: IColorTheme, preference: boolean | 'configuredByTheme' | undefined, signal: AbortSignal): Promise<CodeImageSnapshot> {
	const model = editor?.getModel();
	const selection = editor?.getSelection();
	if (!editor || !model || !selection || selection.isEmpty()) {
		throw new Error(localize('imageEditor.noSelection', 'Select code in an editor before creating a code image.'));
	}
	const version = model.getVersionId();
	await model.tokenization.whenReady(signal);
	signal.throwIfAborted();
	if (model.isDisposed() || model.getVersionId() !== version || editor.getModel() !== model) {
		throw new Error(localize('imageEditor.noSelection', 'Select code in an editor before creating a code image.'));
	}
	const lastLine = selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
	if (lastLine - selection.startLineNumber > 2000 || model.getValueInRange(selection).length > 256 * 1024) throw new Error(localize('imageEditor.selectionTooLarge', 'Select less code to create an image.'));
	const semanticHighlighting = preference === true || (preference !== false && theme.semanticHighlighting === true);
	const font = editor.getOption(EditorOption.fontInfo);
	const element = editor.getDomNode();
	const style = element ? getComputedStyle(element) : undefined;
	const foreground = style?.getPropertyValue('--ash-editor-foreground').trim() || '#d4d4d4';
	const lines: CodeImageSnapshot['lines'][number][] = [];
	for (let line = selection.startLineNumber; line <= lastLine; line++) {
		model.tokenization.forceTokenization(line);
		const tokens = model.tokenization.renderedTokens.getLineTokens(line - 1);
		const content = model.getLineContent(line);
		const start = line === selection.startLineNumber ? selection.startColumn - 1 : 0;
		const end = line === selection.endLineNumber ? selection.endColumn - 1 : content.length;
		const result: CodeImageSnapshot['lines'][number][number][] = [];
		const append = (text: string, presentation: ReturnType<typeof resolveSemanticTokenPresentation> = {}): void => {
			if (!text) return;
			const flags = presentation.fontStyle ?? [];
			result.push({
				text, color: presentation.foreground ?? foreground,
				italic: flags.includes('italic'), bold: flags.includes('bold'),
				underline: flags.includes('underline'), strikethrough: flags.includes('strikethrough'),
			});
		};
		let offset = start;
		for (const token of tokens) {
			const tokenStart = Math.max(start, token.startColumn);
			const tokenEnd = Math.min(end, token.endColumn);
			if (tokenStart >= tokenEnd) continue;
			append(content.slice(offset, tokenStart));
			append(content.slice(tokenStart, tokenEnd), resolveSemanticTokenPresentation(token, theme, semanticHighlighting));
			offset = tokenEnd;
		}
		append(content.slice(offset, end));
		lines.push(result);
	}
	return {
		title: basename(model.uri), firstLine: selection.startLineNumber, lines, foreground,
		background: style?.getPropertyValue('--ash-editor-background').trim() || '#1e1e1e',
		fontFamily: font.fontFamily, fontSize: font.fontSize, tabSize: model.getOptions().tabSize,
	};
}
