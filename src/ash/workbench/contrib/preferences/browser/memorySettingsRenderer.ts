import { h } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { MemoryNamespace } from '../../../../platform/memories/common/memoriesService.js';
import { SettingsPageRenderer } from './settingsRenderers.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';
import { MemoriesEditor } from '../../memories/browser/memoriesEditor.js';
import { IMemorySettingsNavigation, MEMORY_SETTINGS_CATEGORY, type MemorySettingsNavigation, memorySettingsTitle, OPEN_MEMORIES_COMMAND_ID } from '../../memories/browser/memorySettings.js';
import './media/settingsCard.css';
import './media/settingsWidgets.css';

export class MemorySettingsRenderer extends SettingsPageRenderer<SettingsSectionReference> {
	public readonly categoryId = MEMORY_SETTINGS_CATEGORY;
	public readonly onDidChange = Event.None;
	private readonly element: HTMLElement;
	private editor: MemoriesEditor | undefined;
	private visible = false;

	constructor(container: HTMLElement, private readonly namespace: () => MemoryNamespace, private readonly closeSettings: () => Promise<boolean | void>, private readonly revealEditor: (() => void | Promise<void>) | undefined,
		@IMemorySettingsNavigation private readonly navigation: MemorySettingsNavigation,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.element = h(container.ownerDocument, 'div');
		if (!CommandsRegistry.hasCommand(OPEN_MEMORIES_COMMAND_ID)) {
			this.element.textContent = localize({ bundle: 'ash.settings', key: 'memory.unavailable' }, 'Your Ash settings are unavailable in this window.');
		}
	}

	public canClose(): boolean | Promise<boolean> {
		return this.editor?.canClose() ?? true;
	}

	protected buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		const id = 'memory.manage';
		const description = localize({ bundle: 'ash.settings', key: 'memory.description' }, 'Manage Instructions, AGENTS.md, Chats and Code memory switches, and saved memories.');
		return [{
			element: {
				kind: 'item', id, title: memorySettingsTitle(), description,
				value: this.retainElement(id, this.element),
			}
		}];
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.editor?.hideSelects();
			return;
		}
		if (!CommandsRegistry.hasCommand(OPEN_MEMORIES_COMMAND_ID)) { return; }
		// Settings can attach the result or show its dialog after building the page.
		queueMicrotask(() => {
			if (!this.visible || this.isDisposed || !this.element.isConnected) { return; }
			const request = this.navigation.take();
			if (!this.editor) {
				this.editor = this._register(this.instantiation.createInstance(MemoriesEditor, this.namespace(), this.element, this.closeSettings, this.revealEditor));
				this.editor.initialize();
			}
			if (request) { void this.editor.openReference(request.reference); }
		});
	}
}
