import type { IDimension } from '../../../../base/browser/dom.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ServiceConstructionDescriptor } from '../../../../platform/instantiation/common/instantiation.js';

/** One Preferences surface hosted by the shared Preferences editor shell. */
export interface IPreferencesEditorPane extends IDisposable {
	getDomNode(): HTMLElement;
	layout(dimension: IDimension): void;
	search(text: string): void;
	focus(): void;
}

export interface IPreferencesEditorPaneDescriptor {
	readonly id: string;
	readonly title: string;
	readonly order: number;
	readonly ctorDescriptor: ServiceConstructionDescriptor<IPreferencesEditorPane>;
}

/** Owns the Preferences panes contributed within one module realm. */
export class PreferencesEditorPaneRegistry extends Disposable {
	private readonly descriptors = new Map<string, IPreferencesEditorPaneDescriptor>();
	private readonly registerEmitter = this._register(new Emitter<readonly IPreferencesEditorPaneDescriptor[]>());
	private readonly deregisterEmitter = this._register(new Emitter<readonly IPreferencesEditorPaneDescriptor[]>());

	public readonly onDidRegisterPreferencesEditorPanes: Event<readonly IPreferencesEditorPaneDescriptor[]> = this.registerEmitter.event;
	public readonly onDidDeregisterPreferencesEditorPanes: Event<readonly IPreferencesEditorPaneDescriptor[]> = this.deregisterEmitter.event;

	registerPreferencesEditorPane(descriptor: IPreferencesEditorPaneDescriptor): IDisposable {
		this.add(descriptor);
		this.registerEmitter.fire([descriptor]);
		return toDisposable(() => {
			if (this.descriptors.get(descriptor.id) !== descriptor) return;
			this.descriptors.delete(descriptor.id);
			this.deregisterEmitter.fire([descriptor]);
		});
	}

	/** Registers a descriptor whose lifetime intentionally follows the module realm. */
	registerStaticPreferencesEditorPane(descriptor: IPreferencesEditorPaneDescriptor): void {
		this.add(descriptor);
	}

	getPreferencesEditorPanes(): readonly IPreferencesEditorPaneDescriptor[] {
		return [...this.descriptors.values()].sort((left, right) => left.order - right.order);
	}

	private add(descriptor: IPreferencesEditorPaneDescriptor): void {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(descriptor.id)) {
			throw new TypeError(`Invalid Preferences editor pane ID: ${descriptor.id}`);
		}
		if (!descriptor.title.trim()) throw new TypeError(`Preferences editor pane '${descriptor.id}' requires a title`);
		if (!Number.isFinite(descriptor.order)) throw new TypeError(`Preferences editor pane '${descriptor.id}' requires a finite order`);
		if (this.descriptors.has(descriptor.id)) throw new Error(`Preferences editor pane is already registered: ${descriptor.id}`);
		this.descriptors.set(descriptor.id, descriptor);
	}
}

export const PreferencesEditorPanes = new PreferencesEditorPaneRegistry();

export function registerPreferencesEditorPane(descriptor: IPreferencesEditorPaneDescriptor): void {
	PreferencesEditorPanes.registerStaticPreferencesEditorPane(descriptor);
}
