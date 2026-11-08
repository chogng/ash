import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { Part } from '../../../workbench/browser/part.js';
import type { ICustomViewDescriptor } from '../../services/customView/browser/customView.js';
import type { ICustomViewGridPartService } from '../../services/customView/browser/customViewGridPartService.js';
import { CustomViewNode } from './customViewNode.js';
import './media/customViewGridPart.css';

/** Passive host. Workbench selects the view and commits its visibility before focusing it. */
export class CustomViewGridPart extends Part implements ICustomViewGridPartService {
	private readonly node = this._register(new MutableDisposable<CustomViewNode>());
	private descriptor: ICustomViewDescriptor | undefined;

	override get minimumWidth(): number { return 300; }

	constructor(container: HTMLElement,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService theme: IThemeService, @IStorageService storage: IStorageService,
	) {
		super(container, 'customview', theme, storage);
		this.titleDomNode.hidden = true;
	}

	setView(descriptor: ICustomViewDescriptor | undefined): void {
		if (descriptor === this.descriptor) return;
		this.node.clear();
		this.descriptor = undefined;
		if (!descriptor) return;

		this.node.value = this.instantiation.createInstance(CustomViewNode, this.contentDomNode, descriptor);
		this.descriptor = descriptor;
	}

	focusActiveView(): void { this.node.value?.focus(); }
}
