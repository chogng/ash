import { Disposable, DisposableStore } from "../../../../base/common/lifecycle.js";
import type { URI } from "../../../../base/common/uri.js";
import { localize } from "../../../../nls.js";
import { FileKind, IFileService, type IFileEntry } from "../../../../platform/files/common/files.js";
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import type { FileElement } from "./breadcrumbsModel.js";
import type { LanguageDocumentSymbol } from "../../../../editor/common/languages.js";
import type { Range } from "../../../../editor/common/core/range.js";

interface FilePickItem extends IQuickPickItem {
	readonly entry: IFileEntry;
}

/** Navigates files beside a breadcrumb without changing the active editor until a file is chosen. */
export class BreadcrumbsFilePicker extends Disposable {
	private readonly pickerDisposables = this._register(new DisposableStore());
	private picker: IQuickPick<FilePickItem> | undefined;
	private directory: URI;
	private readSequence = 0;

	constructor(
		element: FileElement,
		private readonly openFile: (resource: URI) => Promise<void>,
		@IFileService private readonly fileService: IFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		const path = element.uri.path;
		this.directory = element.kind === FileKind.Directory
			? element.uri
			: element.uri.withPath(path.slice(0, path.lastIndexOf("/")) || "/");
	}

	async show(): Promise<void> {
		const picker = this.quickInputService.createQuickPick<FilePickItem>();
		this.picker = picker;
		this.pickerDisposables.add(picker);
		picker.ariaLabel = localize("workbench.breadcrumbsPickerAriaLabel", "Files in editor breadcrumb");
		this.pickerDisposables.add(picker.onDidAccept(item => {
			if (item.entry.kind === FileKind.Directory) {
				void this.showDirectory(item.entry.resource).catch(reportDirectoryError);
				return;
			}
			picker.hide();
			void this.openFile(item.entry.resource).catch(reportOpenError);
		}));
		this.pickerDisposables.add(picker.onDidHide(() => this.dispose()));
		await this.showDirectory(this.directory);
		picker.show();
	}

	private async showDirectory(directory: URI): Promise<void> {
		const sequence = ++this.readSequence;
		const entries = await this.fileService.readDirectory(directory);
		if (sequence !== this.readSequence || !this.picker) return;
		this.directory = directory;
		const sorted = [...entries].sort((left, right) =>
			Number(right.kind === FileKind.Directory) - Number(left.kind === FileKind.Directory)
			|| left.name.localeCompare(right.name));
		this.picker.placeholder = localize("workbench.breadcrumbsPickerPlaceholder", "Select a file in {0}", directory.path);
		this.picker.items = sorted.map(entry => ({
			entry,
			label: entry.name,
			description: entry.kind === FileKind.Directory
				? localize("workbench.breadcrumbsDirectory", "Directory")
				: undefined,
		}));
		this.picker.value = "";
	}

	override dispose(): void {
		this.readSequence++;
		this.picker = undefined;
		super.dispose();
	}
}

function reportDirectoryError(error: unknown): void {
	console.error("Could not read breadcrumb directory", error);
}

function reportOpenError(error: unknown): void {
	console.error("Could not open breadcrumb file", error);
}

interface SymbolPickItem extends IQuickPickItem {
	readonly symbol: LanguageDocumentSymbol;
}

/** Lets a breadcrumb select another symbol from the active document outline. */
export class BreadcrumbsSymbolPicker extends Disposable {
	constructor(
		private readonly symbols: readonly LanguageDocumentSymbol[],
		private readonly selected: LanguageDocumentSymbol,
		private readonly reveal: (range: Range) => void,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
	}

	show(): void {
		const picker = this._register(this.quickInputService.createQuickPick<SymbolPickItem>());
		picker.ariaLabel = localize("workbench.breadcrumbsSymbolPickerAriaLabel", "Symbols in active editor");
		picker.placeholder = localize("workbench.breadcrumbsSymbolPickerPlaceholder", "Select a symbol (current: {0})", this.selected.name);
		picker.items = this.symbols.flatMap(symbol => flattenSymbol(symbol));
		this._register(picker.onDidAccept(item => {
			picker.hide();
			this.reveal(item.symbol.selectionRange);
		}));
		this._register(picker.onDidHide(() => this.dispose()));
		picker.show();
	}
}

function flattenSymbol(symbol: LanguageDocumentSymbol, parent = ""): readonly SymbolPickItem[] {
	const description = parent || undefined;
	const own: SymbolPickItem = { symbol, label: symbol.name, description };
	const nextParent = parent ? `${parent} › ${symbol.name}` : symbol.name;
	return [own, ...(symbol.children ?? []).flatMap(child => flattenSymbol(child, nextParent))];
}
