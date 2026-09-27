import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Schemas } from "../../../../base/common/network.js";
import { extUri } from "../../../../base/common/resources.js";
import { URI } from "../../../../base/common/uri.js";
import { IWorkingCopyService } from "../../workingCopy/common/workingCopyService.js";
import { type IUntitledTextEditor, type IUntitledTextEditorService, type UntitledTextEditorOptions } from "../common/untitledTextEditorService.js";

/** Browser-side owner for Workbench untitled editor identities. */
export class BrowserUntitledTextEditorService extends Disposable implements IUntitledTextEditorService {
	private readonly editors = new Map<string, UntitledTextEditor>();
	private readonly _onDidCreate = this._register(new Emitter<IUntitledTextEditor>());
	private readonly _onDidChangeLabel = this._register(new Emitter<IUntitledTextEditor>());
	private nextUntitledNumber = 1;

	readonly onDidCreate = this._onDidCreate.event;
	readonly onDidChangeLabel = this._onDidChangeLabel.event;

	constructor(@IWorkingCopyService private readonly workingCopies: IWorkingCopyService) {
		super();
		this._register(toDisposable(() => this.reset()));
		this._register(workingCopies.onDidUnregister(copy => {
			if (!this.isUntitled(copy.resource) || this.workingCopies.get(copy.resource).length > 0) return;
			const key = extUri.getComparisonKey(copy.resource);
			this.editors.get(key)?.dispose();
			this.editors.delete(key);
		}));
	}

	create(options: UntitledTextEditorOptions = {}): IUntitledTextEditor {
		validateOptions(options);
		let resource = options.untitledResource;
		if (resource) {
			const existing = this.get(resource);
			if (existing) return existing;
			const number = /^\/Untitled-(\d+)$/u.exec(resource.path);
			if (number) this.nextUntitledNumber = Math.max(this.nextUntitledNumber, Number(number[1]) + 1);
		} else {
			do {
				resource = URI.parse(`${Schemas.untitled}:/Untitled-${this.nextUntitledNumber++}`);
			} while (this.editors.has(extUri.getComparisonKey(resource)));
		}
		const label = options.label ?? (resource.path.split("/").pop() || resource.authority || resource.toString());
		const editor = new UntitledTextEditor(resource, label, options.initialText ?? "", options.languageId);
		this.editors.set(extUri.getComparisonKey(editor.resource), editor);
		this._onDidCreate.fire(editor);
		return editor;
	}

	get(resource: URI): IUntitledTextEditor | undefined {
		if (!this.isUntitled(resource)) return undefined;
		return this.editors.get(extUri.getComparisonKey(resource));
	}

	rename(resource: URI, label: string): IUntitledTextEditor | undefined {
		if (!this.isUntitled(resource)) return undefined;
		if (typeof label !== 'string' || label.trim().length === 0) throw new TypeError('Untitled editor label must be a non-empty string');
		const key = extUri.getComparisonKey(resource);
		const current = this.editors.get(key);
		if (!current || current.label === label) return current;
		current.setLabel(label);
		this._onDidChangeLabel.fire(current);
		return current;
	}

	isUntitled(resource: URI): boolean {
		return resource.scheme === Schemas.untitled;
	}

	reset(): void {
		for (const editor of this.editors.values()) editor.dispose();
		this.editors.clear();
		this.nextUntitledNumber = 1;
	}
}

class UntitledTextEditor extends Disposable implements IUntitledTextEditor {
	private readonly labelEmitter = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelEmitter.event;

	constructor(readonly resource: URI, private currentLabel: string, readonly initialText: string, readonly languageId: string | undefined) {
		super();
	}

	get label(): string { return this.currentLabel; }

	setLabel(label: string): void {
		this.currentLabel = label;
		this.labelEmitter.fire();
	}
}

function validateOptions(options: UntitledTextEditorOptions): void {
	if (!options || typeof options !== "object") {
		throw new TypeError("Untitled editor options must be an object");
	}
	if (options.initialText !== undefined && typeof options.initialText !== "string") {
		throw new TypeError("Untitled editor initial text must be a string");
	}
	if (options.languageId !== undefined && (typeof options.languageId !== "string" || options.languageId.trim().length === 0)) {
		throw new TypeError("Untitled editor language id must be a non-empty string");
	}
	if (options.label !== undefined && (typeof options.label !== 'string' || options.label.trim().length === 0)) {
		throw new TypeError('Untitled editor label must be a non-empty string');
	}
	if (options.untitledResource !== undefined && (!(options.untitledResource instanceof URI) || options.untitledResource.scheme !== Schemas.untitled)) {
		throw new TypeError("Untitled editor resource must use the untitled scheme");
	}
}
