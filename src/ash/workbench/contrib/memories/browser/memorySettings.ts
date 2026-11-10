import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IPreferencesService } from '../../../services/preferences/common/preferences.js';

export const OPEN_MEMORIES_COMMAND_ID = 'ash.memories.open';
export const MEMORY_SETTINGS_CATEGORY = 'memory';
export const MEMORIES_FOCUS_CONTEXT = 'memoriesFocus';

export function memorySettingsTitle(): string {
	return localize({ bundle: 'ash.settings', key: 'categories.memory.label' }, 'Your Ash');
}

interface MemorySettingsRequest { readonly kind: 'reference'; readonly reference: string; }

export const IMemorySettingsNavigation = createServiceIdentifier<MemorySettingsNavigation>('memorySettingsNavigation');

/** Hands a chat action to the Settings page opened in the same window. */
export class MemorySettingsNavigation {
	private pending: MemorySettingsRequest | undefined;
	private focusedSave: (() => Promise<void>) | undefined;

	async open(preferences: IPreferencesService, request?: MemorySettingsRequest): Promise<void> {
		this.pending = request;
		try {
			await preferences.openSettings({ section: MEMORY_SETTINGS_CATEGORY, query: '', jsonEditor: false });
		} finally {
			if (this.pending === request) { this.pending = undefined; }
		}
	}

	take(): MemorySettingsRequest | undefined {
		const request = this.pending;
		this.pending = undefined;
		return request;
	}

	setFocusedSave(save: () => Promise<void>): void {
		this.focusedSave = save;
	}

	clearFocusedSave(save: () => Promise<void>): void {
		if (this.focusedSave === save) { this.focusedSave = undefined; }
	}

	async save(): Promise<void> {
		await this.focusedSave?.();
	}
}
