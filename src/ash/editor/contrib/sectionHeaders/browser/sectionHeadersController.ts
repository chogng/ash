import "./media/sectionHeaders.css";
import { StandardTokenType } from "../../../common/encodedTokenAttributes.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { findSectionHeaders, type SectionHeader, type FindSectionHeaderOptions } from "../../../common/services/findSectionHeaders.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type View } from "../../../browser/view.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { MinimapPosition, MinimapSectionHeaderStyle } from '../../../common/model.js';
import { type IEditorDecorationsCollection } from '../../../common/editorCommon.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

/** Marks named source sections for browser presentation and accessibility. */
export class SectionHeadersController extends Disposable {
	private decorationKey = '';
	private readonly decorations: IEditorDecorationsCollection;
	private readonly refresh = this._register(new RunOnceScheduler(() => this.update(), 250));
	private cached: { version: number; windows: string; rules: FindSectionHeaderOptions['foldingRules']; headers: readonly SectionHeader[]; } | undefined;
	constructor(
		private readonly viewport: View,
		private readonly model: TextModel,
		private readonly editor: ICodeEditor,
		private readonly configurations: ILanguageConfigurationService,
		private readonly readOptions: () => Omit<FindSectionHeaderOptions, "foldingRules">,
	) {
		super();
		if (model !== viewport.textModel) throw new TypeError("Stanza section header dependencies must share a text model");
		this.decorations = editor.createDecorationsCollection();
		this._register(toDisposable(() => {
			this.decorations.clear();
			for (const line of viewport.domNode.domNode.querySelectorAll<HTMLElement>('.view-line.section-header')) {
				line.classList.remove('section-header', 'section-header-separator');
				line.removeAttribute('data-section-header');
			}
		}));
		this._register(viewport.onDidChangeLayout(() => {
			if (!this.refresh.isScheduled()) this.update();
		}));
		this._register(model.onDidChangeContent(() => {
			// Full-document map headers are coalesced away from the typing path.
			if (editor.getOption(EditorOption.minimap).enabled) this.refresh.schedule();
			else this.update();
		}));
		this._register(model.onDidChangeTokens(() => {
			if (!this.refresh.isScheduled()) this.update();
		}));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.minimap)) {
				this.cached = undefined;
				this.refresh.schedule(0);
			}
		}));
		this._register(model.onDidChangeLanguage(() => {
			this.cached = undefined;
			this.refresh.schedule(0);
		}));
		this._register(configurations.onDidChange(event => {
			if (event.affects(model.getLanguageId())) {
				this.cached = undefined;
				this.refresh.schedule(0);
			}
		}));
		if (editor.getOption(EditorOption.minimap).enabled) this.refresh.schedule(0);
		else this.update();
	}

	private isComment(lineNumber: number, column: number): boolean {
		const tokens = this.model.tokenization.getLineTokens(lineNumber);
		return tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(column - 1)) === StandardTokenType.Comment;
	}

	private update(): void {
		const configuration = this.configurations.getLanguageConfiguration(this.model.getLanguageId());
		const lines = [...this.viewport.domNode.domNode.querySelectorAll<HTMLElement>(".view-line")];
		const minimap = this.editor.getOption(EditorOption.minimap);
		const options = this.readOptions();
		if (lines.length === 0 && !minimap.enabled) {
			return;
		}
		const indices = lines.map(line => Number(line.dataset.logicalLineIndex));
		// MARK patterns are searched in 100-line chunks overlapping by five.
		// Keep the global chunk alignment and the preceding chunk so multiline
		// headers crossing the viewport boundary retain the same matching rules.
		const windows: { start: number; end: number; }[] = [];
		for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
			const start = Math.max(0, (Math.floor(index / 95) - 1) * 95);
			const end = Math.min(this.model.getLineCount(), Math.floor(index / 95) * 95 + 100);
			const previous = windows.at(-1);
			if (previous && previous.end >= start) {
				previous.end = Math.max(previous.end, end);
			} else {
				windows.push({ start, end });
			}
		}
		// The same candidate cache feeds both the document map and visible source
		// markers. Without a map, retain the bounded visible-chunk scan.
		if (minimap.enabled) windows.splice(0, windows.length, { start: 0, end: this.model.getLineCount() });
		const key = windows.map(window => `${window.start}:${window.end}`).join(',');
		if (!this.cached || this.cached.version !== this.model.version || this.cached.windows !== key || this.cached.rules !== configuration.foldingRules) {
			const headers = windows.flatMap(({ start, end }) => findSectionHeaders({
				getLineCount: () => end - start,
				getLineContent: line => this.model.getLineContent(line + start),
			}, { ...options, foldingRules: configuration.foldingRules }).map(header => ({
				...header, range: { ...header.range, startLineNumber: header.range.startLineNumber + start, endLineNumber: header.range.endLineNumber + start },
			})));
			this.cached = { version: this.model.version, windows: key, rules: configuration.foldingRules, headers };
		}
		// Tokens can change whether a candidate is a comment; they do not change
		// the candidate text. Layout/token notifications never rescan the file.
		const accepted = this.cached.headers.filter(header => !header.shouldBeInComments || this.isComment(header.range.startLineNumber, header.range.startColumn));
		const mapHeaders = minimap.enabled ? accepted.filter(header => header.shouldBeInComments ? minimap.showMarkSectionHeaders : minimap.showRegionSectionHeaders) : [];
		const decorationKey = JSON.stringify(mapHeaders);
		if (decorationKey !== this.decorationKey) {
			this.decorationKey = decorationKey;
			this.decorations.set(mapHeaders.map(header => ({
				range: header.range,
				options: {
					description: 'section-header',
					minimap: {
						color: undefined,
						position: MinimapPosition.Inline,
						sectionHeaderText: header.text,
						sectionHeaderStyle: header.hasSeparatorLine ? MinimapSectionHeaderStyle.Underlined : MinimapSectionHeaderStyle.Normal,
					},
				},
			})));
		}
		const headers = new Map(accepted.map(header => [header.range.startLineNumber - 1, header]));
		for (const line of lines) {
			const logicalLineIndex = Number(line.dataset.logicalLineIndex);
			const header = headers.get(logicalLineIndex);
			line.classList.toggle("section-header", Boolean(header));
			if (header) {
				line.setAttribute("data-section-header", "true");
				line.classList.toggle("section-header-separator", header.hasSeparatorLine);
			} else {
				line.removeAttribute("data-section-header");
				line.classList.remove("section-header-separator");
			}
		}
	}
}
