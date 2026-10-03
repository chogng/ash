import type { IDimension } from '../../base/browser/dom.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { Emitter } from '../../base/common/event.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import type { EditorInput } from '../../workbench/services/editor/common/editorService.js';
import type { ISessionsPageDescriptor } from '../common/pages.js';

/** The host retains each page until disposal, preserving its state across navigation. */
export interface ISessionsPageView extends IDisposable {
	readonly domNode: HTMLElement;
	setVisible(visible: boolean): void;
	focus(): void;
	layout(dimension: IDimension): void;
}

export interface ISessionsPageContribution extends ISessionsPageDescriptor {
	readonly viewDescriptor?: SyncDescriptor<ISessionsPageView>;
	readonly getEditorInput?: (accessor: ServicesAccessor) => EditorInput;
}

class SessionsPageContributionRegistry {
	private readonly pages = new Map<string, ISessionsPageContribution>();
	private readonly didChange = new Emitter<void>();
	public readonly onDidChange = this.didChange.event;

	public registerPage(descriptor: ISessionsPageContribution): IDisposable {
		if (this.pages.has(descriptor.id)) {
			throw new Error(`Sessions page already registered: ${descriptor.id}`);
		}
		this.pages.set(descriptor.id, descriptor);
		this.didChange.fire();
		return toDisposable(() => {
			this.pages.delete(descriptor.id);
			this.didChange.fire();
		});
	}

	public getPages(): ReadonlyMap<string, ISessionsPageContribution> {
		return this.pages;
	}
}

export const SessionsPageRegistry = new SessionsPageContributionRegistry();
