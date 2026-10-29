import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatAttachmentWidgetRegistry } from './chatAttachmentWidgetRegistry.js';
import { ChatReferenceAttachmentWidget } from './chatAttachmentWidgets.js';

/** Installs the existing Sessions context source in the shared inline attachment renderer. */
export class ChatReferenceAttachmentWidgetContribution extends Disposable {
	static readonly ID = 'workbench.contrib.chatReferenceAttachmentWidgetFactory';

	constructor(@IChatAttachmentWidgetRegistry registry: IChatAttachmentWidgetRegistry, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this._register(registry.registerFactory('sessionReference', (attachment, options, container) => instantiation.createInstance(ChatReferenceAttachmentWidget, attachment, options, container)));
	}
}
