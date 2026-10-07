import "./media/sectionHeaders.css";
import { StandardTokenType } from "../../../common/encodedTokenAttributes.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { findSectionHeaders, type FindSectionHeaderOptions } from "../../../common/services/findSectionHeaders.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type View } from "../../../browser/view.js";

/** Marks named source sections for browser presentation and accessibility. */
export class SectionHeadersController extends Disposable {
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
		const headers = new Map(findSectionHeaders(this.model, {
			...this.options,
			foldingRules: configuration.foldingRules,
		}).filter(header => !header.shouldBeInComments || this.isComment(header.range.startLineNumber, header.range.startColumn))
			.map(header => [header.range.startLineNumber - 1, header]));
		for (const line of [...this.viewport.domNode.domNode.querySelectorAll<HTMLElement>(".view-line")]) {
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
