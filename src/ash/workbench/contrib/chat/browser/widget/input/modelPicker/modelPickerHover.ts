import { DisposableStore, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { ModelCard } from './modelPickerCard.js';

/** Renders the read-only card for the action list's anchored model preview. */
export function renderModelPickerHover(entry: ModelCatalogEntry, container: HTMLElement, instantiationService: IInstantiationService): IDisposable | undefined {
	if (!entry.description?.trim() && !(entry.maximumContextWindow ?? entry.contextWindow)) return undefined;
	const resources = new DisposableStore();
	const document = container.ownerDocument;
	const cards = ModelCard.instantiateObservable(instantiationService, resources, document, undefined);
	const render = (card: ModelCard): void => {
		const hadFocus = container.contains(document.activeElement);
		card.update(entry);
		container.replaceChildren(card.element);
		if (hadFocus) card.focus();
	};
	render(cards.get());
	resources.add(cards.onDidChange(render));
	return resources;
}
