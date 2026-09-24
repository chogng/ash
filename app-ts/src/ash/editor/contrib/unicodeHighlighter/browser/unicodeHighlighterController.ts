import "./unicodeHighlighter.css";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type TextDecorationCollection } from "../../../common/model/decorationCollection.js";

import { type TextModel } from "../../../common/model/textModel.js";
import { type IVersionedEditorWorkerClient } from "../../../browser/services/editorWorkerService.js";
import { type UnicodeHighlight } from "../common/unicodeHighlights.js";
import { TrackedRangeStickiness } from '../../../common/model.js';

/** Maintains Unicode warning ranges as a feature-owned decoration collection. */
export class UnicodeHighlighterController extends Disposable {
	private lastVersion = -1;

	constructor(private readonly model: TextModel, readonly decorations: TextDecorationCollection<UnicodeHighlight>, private readonly editorWorker: IVersionedEditorWorkerClient, private readonly onError: (error: unknown) => void) {
		super();
		if (decorations.textModel !== model) throw new TypeError("Stanza Unicode highlighter dependencies must share a text model");
		this._register(model.onDidChangeContent(() => this.update()));
		this.update();
	}

	private update(): void {
		if (this.lastVersion === this.model.version) return;
		const version = this.lastVersion = this.model.version;
		void this.compute(version);
	}

	private async compute(version: number): Promise<void> {
		try {
			const highlights = await this.editorWorker.computeUnicodeHighlights();
			if (!highlights || this.isDisposed || this.model.version !== version) return;
			this.decorations.replaceAll(highlights.map(highlight => ({
				range: highlight.range,
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				options: {
					description: 'unicode-highlight',
					className: 'unicode-highlight',
					hoverMessage: { value: `${highlight.kind} Unicode character U+${highlight.character.codePointAt(0)!.toString(16).toUpperCase()}` },
				},
				metadata: highlight,
			})));
		} catch (error) {
			if (!this.isDisposed && this.model.version === version) {
				this.lastVersion = -1;
				this.onError(error);
			}
		}
	}
}
