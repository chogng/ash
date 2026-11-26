import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { EditSources } from '../../../../editor/common/textModelEditSource.js';
import {
	parseSearchEditor, readSearchEditorResults, searchEditorRows, serializeSearchEditor, serializeSearchEditorQuery,
	type SearchEditorQuery, type SearchEditorResults,
} from './searchEditorSerialization.js';

export const searchEditorQueryEdit = 'searchEditor.query';
export const searchEditorResultsEdit = 'searchEditor.results';

/** One query and editable results buffer per saved working copy, shared by all of its panes. */
export class SearchEditorModel extends Disposable {
	private static readonly models = new WeakMap<TextModel, SearchEditorModel>();
	private readonly changed = this._register(new Emitter<'query' | 'results' | 'document'>());
	readonly onDidChange = this.changed.event;
	readonly results: TextModel;
	private configuration: SearchEditorQuery | undefined;
	private files: SearchEditorResults['files'] = [];
	private synchronizing = false;
	private hasCurrentFormat = false;

	static resolve(backing: TextModel, labelResource: (resource: URI) => string): SearchEditorModel {
		const existing = this.models.get(backing);
		if (existing) return existing;
		const model = new SearchEditorModel(backing, labelResource);
		this.models.set(backing, model);
		return model;
	}

	private constructor(private readonly backing: TextModel, private readonly labelResource: (resource: URI) => string) {
		super();
		this.results = this._register(new TextModel('', { resource: backing.uri, languageId: 'plaintext' }));
		this.readBacking();
		this._register(backing.onWillDispose(() => this.dispose()));
		this._register(backing.onDidChangeContent(() => {
			if (!this.synchronizing) this.readBacking();
		}));
		this._register(this.results.onDidChangeContent(() => {
			if (!this.synchronizing) this.writeBacking('searchEditor.editResults');
		}));
	}

	get query(): SearchEditorQuery | undefined { return this.configuration; }
	get version(): number { return this.backing.version; }

	updateQuery(query: SearchEditorQuery): void {
		if (!this.configuration) return;
		const header = serializeSearchEditorQuery(query);
		if (header === serializeSearchEditorQuery(this.configuration)) return;
		this.configuration = query;
		if (this.hasCurrentFormat) {
			this.writeBacking(searchEditorQueryEdit, header, new Range(1, 1, 1, this.backing.getLineMaxColumn(1)));
		} else {
			this.writeBacking(searchEditorQueryEdit);
		}
		this.changed.fire('query');
	}

	replaceResults(results: SearchEditorResults): void {
		this.files = results.files;
		this.setResultsText(results.text);
		this.writeBacking(searchEditorResultsEdit);
		this.changed.fire('results');
	}

	get rows(): ReturnType<typeof searchEditorRows> {
		return searchEditorRows({ files: this.files, text: this.results.getText() });
	}

	location(line: number, column: number): { resource: URI; range: Range; } | undefined {
		for (const row of this.rows) {
			if (row.line > line) break;
			if (row.line !== line) continue;
			const resource = URI.parse(row.file.resource, true);
			if (row.header) return { resource, range: new Range(1, 1, 1, 1) };
			const offset = column - row.offset - 1;
			const match = row.matches.find(match => offset >= match.start && offset <= match.end) ?? row.matches[0];
			const source = match?.source;
			return { resource, range: source ? Range.lift(source) : new Range(row.number, 1, row.number, 1) };
		}
		return undefined;
	}

	private readBacking(): void {
		const text = this.backing.getText();
		try {
			const query = parseSearchEditor(text);
			const results = readSearchEditorResults(text, this.labelResource);
			this.configuration = query;
			this.hasCurrentFormat = !results.legacy;
			this.files = results.files;
			this.setResultsText(results.text);
		} catch {
			this.configuration = undefined;
			this.hasCurrentFormat = false;
			this.files = [];
			this.setResultsText(text);
		}
		this.changed.fire('document');
	}

	private setResultsText(text: string): void {
		if (text === this.results.getText()) return;
		this.synchronizing = true;
		try {
			this.results.reset(text);
		} finally {
			this.synchronizing = false;
		}
	}

	private writeBacking(source: string, serialized?: string, range = this.backing.getFullModelRange()): void {
		const text = this.configuration
			? serialized ?? serializeSearchEditor(this.configuration, { files: this.files, text: this.results.getText() })
			: this.results.getText();
		if (text === this.backing.getValueInRange(range)) return;
		this.synchronizing = true;
		try {
			this.backing.applyOperations([{ range, text }], { editSource: EditSources.unknown({ name: source }) });
			this.hasCurrentFormat = !!this.configuration;
		} finally {
			this.synchronizing = false;
		}
	}
}
