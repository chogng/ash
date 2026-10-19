import { TextModel } from '../../../../src/ash/editor/common/model/textModel.js';
import type { Event } from '../../../../src/ash/base/common/event.js';
import type { DocumentSelection } from '../core/documentSelection.js';
import type { DocumentMark, DocumentNode } from './document.js';
import type { DocumentHistoryEntries } from './documentHistory.js';
import type { DocumentPluginKey } from './documentPlugin.js';
import type { DocumentSchema } from './documentSchema.js';
import type { DocumentTransaction } from './documentTransaction.js';
import { TextModelBlockState, TextModelRemoteHistoryPolicy, type TextModelBlockChange, type TextModelBlockOptions, type TextModelPluginDecorationSource } from './textModelBlockState.js';
import { projectDocumentToLines } from './lineDocumentProjection.js';

/** Academy's semantic transaction owner over the shared text buffer and version. */
export class DocumentTextModel extends TextModel {
	private readonly blockState: TextModelBlockState;

	private constructor(schema: DocumentSchema, document: DocumentNode, options: TextModelBlockOptions) {
		super('', { extensionSnapshot: projectDocumentToLines(schema, document) });
		try {
			this.blockState = this._register(new TextModelBlockState(schema, document, options, {
				getVersion: () => this.version,
				commit: snapshot => this.commitExtensionSnapshot(snapshot),
				publishTextChange: change => this.publishTextChange(change),
			}));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	static create(schema: DocumentSchema, document = schema.createDocument(), options: TextModelBlockOptions = {}): DocumentTextModel {
		return new DocumentTextModel(schema, document, options);
	}

	get documentType(): string { return this.blockState.schema.documentType; }

	get schema(): DocumentSchema {
		return this.blockState.schema;
	}

	get document(): DocumentNode {
		return this.blockState.document;
	}

	get selection(): DocumentSelection | undefined {
		return this.blockState.selection;
	}

	get storedMarks(): readonly DocumentMark[] | undefined {
		return this.blockState.storedMarks;
	}

	get onDidChangeBlocks(): Event<TextModelBlockChange> {
		return this.blockState.onDidChange;
	}

	get onDidChangeSelection(): Event<DocumentSelection | undefined> {
		return this.blockState.onDidChangeSelection;
	}

	get onDidChangeStoredMarks(): Event<readonly DocumentMark[] | undefined> {
		return this.blockState.onDidChangeStoredMarks;
	}

	get canUndoBlocks(): boolean {
		return this.blockState.canUndo;
	}

	get canRedoBlocks(): boolean {
		return this.blockState.canRedo;
	}

	dispatch(transaction: DocumentTransaction): TextModelBlockChange | undefined {
		return this.blockState.dispatch(transaction);
	}

	dispatchRemote(transaction: DocumentTransaction, historyPolicy: TextModelRemoteHistoryPolicy = TextModelRemoteHistoryPolicy.Clear): TextModelBlockChange | undefined {
		return this.blockState.dispatchRemote(transaction, historyPolicy);
	}

	rebaseHistory(mapper: (entries: DocumentHistoryEntries) => DocumentHistoryEntries): void {
		this.blockState.rebaseHistory(mapper);
	}

	undoBlocks(): TextModelBlockChange | undefined {
		return this.blockState.undo();
	}

	redoBlocks(): TextModelBlockChange | undefined {
		return this.blockState.redo();
	}

	setSelection(selection: DocumentSelection | undefined): void {
		this.blockState.setSelection(selection);
	}

	setStoredMarks(marks: readonly DocumentMark[] | undefined): void {
		this.blockState.setStoredMarks(marks);
	}

	resetBlocks(document: DocumentNode): TextModelBlockChange | undefined {
		return this.blockState.reset(document);
	}

	getPluginState<T>(key: DocumentPluginKey<T>): T | undefined {
		return this.blockState.getPluginState(key);
	}

	getPluginDecorations(): readonly TextModelPluginDecorationSource[] {
		return this.blockState.getPluginDecorations();
	}

}
