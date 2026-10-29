import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { materializeExtensionFileTemplate } from '../../../services/extensions/common/extensionSnippetProvider.js';
import type { ExtensionFileTemplateDefinition } from '../../../services/extensions/common/extensionFileTemplate.js';
import {
	IExtensionService,
	type ExtensionSnippetActivation,
	type ExtensionSnippetFile,
} from '../../../services/extensions/common/extensionService.js';
import type { ISnippetsService } from './snippets.js';
import { SnippetFile, type Snippet } from './snippetsFile.js';

export class SnippetsService extends Disposable implements ISnippetsService {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private files: readonly SnippetFile[] = [];
	public readonly onDidChange = this.changeEmitter.event;

	constructor(@IExtensionService extensions: IExtensionService) {
		super();
		this._register(extensions.registerSnippetHandler(resources => this.prepare(resources)));
	}

	public getSnippetsSync(languageId: string): Snippet[] {
		this.assertNotDisposed();
		return this.files.flatMap(file => file.data.filter(snippet => snippet.scopes.includes(languageId)));
	}

	private prepare(resources: readonly ExtensionSnippetFile[]): ExtensionSnippetActivation {
		this.assertNotDisposed();
		const merged = new Map<string, ExtensionSnippetFile>();
		for (const resource of resources) {
			const key = resource.location.toString();
			const previous = merged.get(key);
			merged.set(
				key,
				previous
					? { ...resource, languageIds: [...new Set([...previous.languageIds, ...resource.languageIds])] }
					: resource,
			);
		}
		const entries = [...merged.values()];
		const files = entries.map(resource => new SnippetFile(resource));
		const fileTemplates: ExtensionFileTemplateDefinition[] = [];
		for (const [index, file] of files.entries()) {
			const names = new Set<string>();
			for (const snippet of file.data) {
				if (!snippet.isFileTemplate || names.has(snippet.name)) {
					continue;
				}
				names.add(snippet.name);
				for (const languageId of snippet.scopes) {
					fileTemplates.push({
						id: JSON.stringify([entries[index].extensionId, file.location.path, snippet.name, languageId]),
						extensionId: entries[index].extensionId,
						label: snippet.name,
						languageId,
						body: materializeExtensionFileTemplate(snippet),
						description: snippet.description ? snippet.description.replace(/[\r\n]+/gu, ' ') : undefined,
					});
				}
			}
		}
		const previous = this.files;
		return {
			fileTemplates,
			commit: () => {
				this.assertNotDisposed();
				this.files = files;
				this.changeEmitter.fire();
			},
			rollback: () => {
				if (this.isDisposed || this.files === previous) {
					return;
				}
				this.files = previous;
				this.changeEmitter.fire();
			},
		};
	}

	protected override disposeCore(): void {
		this.files = [];
		super.disposeCore();
	}
}
