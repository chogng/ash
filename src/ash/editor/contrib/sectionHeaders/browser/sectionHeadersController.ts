import "./media/sectionHeaders.css";
import { StandardTokenType } from "../../../common/encodedTokenAttributes.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { findSectionHeaders, type SectionHeader, type FindSectionHeaderOptions } from "../../../common/services/findSectionHeaders.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type View } from "../../../browser/view.js";

/** Marks named source sections for browser presentation and accessibility. */
export class SectionHeadersController extends Disposable {
	private cached: { version: number; windows: string; rules: FindSectionHeaderOptions['foldingRules']; headers: readonly SectionHeader[]; } | undefined;
	constructor(
		private readonly viewport: View,
		private readonly model: TextModel,
		private readonly languageId: string,
		private readonly configurations: ILanguageConfigurationService,
		private readonly options: Omit<FindSectionHeaderOptions, "foldingRules">,
	) {
		super();
		if (model !== viewport.textModel) throw new TypeError("Stanza section header dependencies must share a text model");
		this._register(viewport.onDidChangeLayout(() => this.update()));
		this._register(model.onDidChangeContent(() => this.update()));
		this._register(model.onDidChangeTokens(() => this.update()));
		this.update();
	}

	private isComment(lineNumber: number, column: number): boolean {
		const tokens = this.model.tokenization.getLineTokens(lineNumber);
		return tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(column - 1)) === StandardTokenType.Comment;
	}

	private update(): void {
		const configuration = this.configurations.getLanguageConfiguration(this.languageId);
		const lines = [...this.viewport.domNode.domNode.querySelectorAll<HTMLElement>(".view-line")];
		if (lines.length === 0) {
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
		const key = windows.map(window => `${window.start}:${window.end}`).join(',');
		if (!this.cached || this.cached.version !== this.model.version || this.cached.windows !== key || this.cached.rules !== configuration.foldingRules) {
			const headers = windows.flatMap(({ start, end }) => findSectionHeaders({
				getLineCount: () => end - start,
				getLineContent: line => this.model.getLineContent(line + start),
			}, { ...this.options, foldingRules: configuration.foldingRules }).map(header => ({
				...header, range: { ...header.range, startLineNumber: header.range.startLineNumber + start, endLineNumber: header.range.endLineNumber + start },
			})));
			this.cached = { version: this.model.version, windows: key, rules: configuration.foldingRules, headers };
		}
		// Tokens can change whether a candidate is a comment; they do not change
		// the candidate text. Layout/token notifications never rescan the file.
		const headers = new Map(this.cached.headers
			.filter(header => !header.shouldBeInComments || this.isComment(header.range.startLineNumber, header.range.startColumn))
			.map(header => [header.range.startLineNumber - 1, header]));
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
