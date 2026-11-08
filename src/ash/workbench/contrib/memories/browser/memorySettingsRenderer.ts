import { h } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { MemoryNamespace } from '../../../../platform/memories/common/memoriesService.js';
import { SettingsPageRenderer } from '../../preferences/browser/settingsRenderers.js';
import type { SettingsSectionReference, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';
import { MemoriesEditor } from './memoriesEditor.js';
import { IMemorySettingsNavigation, MEMORY_SETTINGS_CATEGORY, type MemorySettingsNavigation, memorySettingsTitle, OPEN_MEMORIES_COMMAND_ID } from './memorySettings.js';

export class MemorySettingsRenderer extends SettingsPageRenderer<SettingsSectionReference> {
	public readonly categoryId = MEMORY_SETTINGS_CATEGORY;
	public readonly onDidChange = Event.None;
	private readonly element: HTMLElement;
	private editor: MemoriesEditor | undefined;
	private visible = false;

	constructor(container: HTMLElement, private readonly namespace: () => MemoryNamespace, private readonly closeSettings: () => Promise<void>,
		@IMemorySettingsNavigation private readonly navigation: MemorySettingsNavigation,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.element = h(container.ownerDocument, 'div');
		if (!CommandsRegistry.hasCommand(OPEN_MEMORIES_COMMAND_ID)) {
			this.element.textContent = localize({ bundle: 'ash.settings', key: 'memory.unavailable' }, 'Memory management is unavailable in this window.');
		}
	}

	protected buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		const id = 'memory.manage';
		const description = localize({ bundle: 'ash.settings', key: 'memory.description' }, 'Review, search, edit, or delete saved memories. Control memory reading and model saving for each scope.');
		return [{
			element: {
				kind: 'item', id, title: memorySettingsTitle(), description,
				value: this.retainElement(id, this.element),
			}
		}];
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible || !CommandsRegistry.hasCommand(OPEN_MEMORIES_COMMAND_ID)) { return; }
		// Settings can attach the result or show its dialog after building the page.
		queueMicrotask(() => {
			if (!this.visible || this.isDisposed || !this.element.isConnected) { return; }
			const request = this.navigation.take();
			if (!this.editor) {
				this.editor = this._register(this.instantiation.createInstance(MemoriesEditor, this.namespace(), this.element, this.closeSettings));
				this.editor.initialize();
			}
			if (request?.kind === 'draft') { void this.editor.openProjectDraft(request.origin, request.text); }
			if (request?.kind === 'reference') { void this.editor.openReference(request.reference); }
		});
	}
}
