import './media/accessibleView.css';
import { h } from '../../../../base/browser/dom.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewType, type IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

/** Displays one focused provider in a modal, read-only text surface. */
export class AccessibleViewService extends Disposable implements IAccessibleViewService {
	private readonly current = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService private readonly accessor: IInstantiationService,
	) {
		super();
	}

	public show(type: AccessibleViewType): boolean {
		const root = this.layoutService.mainContainer;
		const activeElement = root.ownerDocument.activeElement;
		const implementations = [...AccessibleViewRegistry.getImplementations()]
			.filter(implementation => implementation.type === type && this.contextKeys.contextMatchesRules(implementation.when, activeElement))
			.sort((left, right) => right.priority - left.priority);
		let provider: AccessibleContentProvider | undefined;
		for (const implementation of implementations) {
			provider = implementation.getProvider(this.accessor);
			if (provider) break;
		}
		if (!provider) return false;

		this.current.clear();
		const lifetime = new DisposableStore();
		lifetime.add(provider);
		try {
			const document = root.ownerDocument;
			const content = h(document, 'textarea');
			content.className = 'ash-accessible-view-content';
			content.readOnly = true;
			content.value = provider.provideContent();
			const title = type === AccessibleViewType.Help
				? localize('accessibility.helpTitle', 'Accessibility Help')
				: localize('accessibility.viewTitle', 'Accessible View');
			content.setAttribute('aria-label', title);
			const dialog = lifetime.add(new Dialog(root, {
				title,
				content,
				buttons: [{ label: localize('accessibility.close', 'Close'), value: 'close' }],
				cancelValue: 'close',
			}));
			dialog.element.classList.add('ash-accessible-view-dialog');
			this.current.value = lifetime;
			void dialog.show().finally(() => {
				if (this.current.value === lifetime) this.current.clear();
			});
		} catch (error) {
			if (this.current.value === lifetime) this.current.clear();
			else lifetime.dispose();
			throw error;
		}
		return true;
	}

	public getOpenAriaHint(verbositySettingKey: string): string | undefined {
		if (!this.configuration.getValue<boolean>(verbositySettingKey)) return undefined;
		return localize('accessibility.openHelpHint', 'Press Alt+F1 for accessibility help.');
	}
}
