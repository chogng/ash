import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";

export interface ExtensionFileTemplateDefinition {
	readonly id: string;
	readonly extensionId: string;
	readonly label: string;
	readonly languageId: string;
	readonly body: string;
	readonly description?: string;
}

export interface ExtensionFileTemplateCatalog {
	readonly revision: number;
	readonly templates: readonly ExtensionFileTemplateDefinition[];
}

/** Read-only file-template catalog exposed to Workbench consumers. */
export interface ExtensionFileTemplateSource {
	readonly currentCatalog: ExtensionFileTemplateCatalog;
	readonly onDidChange: Event<ExtensionFileTemplateCatalog>;
}

/** Owns the active, declarative file templates contributed by extensions. */
export class ExtensionFileTemplateRegistry extends Disposable implements ExtensionFileTemplateSource {
	private readonly changeEmitter = this._register(new Emitter<ExtensionFileTemplateCatalog>());
	private catalog: ExtensionFileTemplateCatalog = Object.freeze({ revision: 0, templates: Object.freeze([]) });

	readonly onDidChange: Event<ExtensionFileTemplateCatalog> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.catalog = Object.freeze({ revision: this.catalog.revision, templates: Object.freeze([]) });
		}));
	}

	get currentCatalog(): ExtensionFileTemplateCatalog {
		this.assertNotDisposed();
		return this.catalog;
	}

	replace(templates: readonly ExtensionFileTemplateDefinition[]): void {
		this.assertNotDisposed();
		if (!Array.isArray(templates)) throw new TypeError("Extension file-template replacement must be an array");
		const normalized = templates.map(normalizeTemplate);
		const ids = new Set<string>();
		for (const template of normalized) {
			if (ids.has(template.id)) throw new RangeError(`Duplicate extension file template '${template.id}'`);
			ids.add(template.id);
		}
		this.catalog = Object.freeze({ revision: this.catalog.revision + 1, templates: Object.freeze(normalized) });
		this.changeEmitter.fire(this.catalog);
	}

}

function normalizeTemplate(template: ExtensionFileTemplateDefinition): ExtensionFileTemplateDefinition {
	if (typeof template !== "object" || template === null) throw new TypeError("Extension file template must be an object");
	if (typeof template.body !== "string" || template.body.length > 1024 * 1024) throw new TypeError("Extension file-template body must be bounded text");
	return Object.freeze({
		id: boundedText(template.id, "Extension file-template ID", 512),
		extensionId: boundedText(template.extensionId, "Extension file-template extension ID", 256),
		label: boundedText(template.label, "Extension file-template label", 256),
		languageId: boundedText(template.languageId, "Extension file-template language ID", 128),
		body: template.body,
		...(template.description === undefined ? {} : { description: boundedText(template.description, "Extension file-template description", 512) }),
	});
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\r\n]/u.test(value)) throw new TypeError(`${owner} is invalid`);
	return value;
}
