import { type Event } from "../../../../base/common/event.js";
import { TextResourceConflictError, type TextResourceChangeEvent, type TextResourceContent, type TextResourceResolveRequest, type TextResourceSaveRequest, type TextResourceSaveResult, type ITextResourceStore } from "../../../services/textmodelResolver/common/textResourceStore.js";
import { type ITextFileService } from "../../../services/textfile/common/textFileService.js";
import { TextFileSaveConflictError } from "../../../services/textfile/common/textFileService.js";

/** Adapts the Workbench text-file service to the editor resource contract. */
export class BrowserTextResourceStore implements ITextResourceStore {
	readonly onDidChange: Event<TextResourceChangeEvent>;

	constructor(private readonly textFiles: ITextFileService) {
		validateTextFileService(textFiles);
		this.onDidChange = listener => textFiles.onDidChangeFiles(event => listener({ resources: event.resources }));
	}

	async resolve(request: TextResourceResolveRequest, signal: AbortSignal): Promise<TextResourceContent> {
		const content = await this.textFiles.resolve(request, signal);
		return Object.freeze({ resource: content.resource, text: content.text, revision: content.revision });
	}

	async save(request: TextResourceSaveRequest, signal: AbortSignal): Promise<TextResourceSaveResult> {
		try {
			return await this.textFiles.save(request, signal);
		} catch (error) {
			if (error instanceof TextFileSaveConflictError) throw new TextResourceConflictError(request.resource);
			throw error;
		}
	}
}

const resourceStores = new WeakMap<ITextFileService, BrowserTextResourceStore>();

/** Shares one adapter identity for the Workbench service lifetime. */
export function getBrowserTextResourceStore(textFiles: ITextFileService): BrowserTextResourceStore {
	validateTextFileService(textFiles);
	const existing = resourceStores.get(textFiles);
	if (existing) return existing;
	const store = new BrowserTextResourceStore(textFiles);
	resourceStores.set(textFiles, store);
	return store;
}

function validateTextFileService(textFiles: ITextFileService): void {
	if (!textFiles || typeof textFiles.resolve !== "function" || typeof textFiles.save !== "function" || typeof textFiles.onDidChangeFiles !== "function") {
		throw new TypeError("Browser resource store requires a Workbench text file service");
	}
}
