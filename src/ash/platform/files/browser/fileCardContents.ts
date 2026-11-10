import { h } from '../../../base/browser/dom.js';
import { Badge } from '../../../base/browser/ui/countBadge/countBadge.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { extname } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ByteSize } from '../common/files.js';
import './fileCardContents.css';

/** File facts and a preview slot. The host owns loading, activation, and layout. */
export class FileCardContents extends Disposable {
	readonly preview: HTMLElement;
	readonly descriptionIds: string;
	private readonly size: HTMLElement;

	constructor(container: HTMLElement, name: string, format?: string) {
		super();
		const document = container.ownerDocument;
		const title = h(document, 'span', { className: 'ash-file-card-name' }, name);
		this.size = h(document, 'span', { className: 'ash-file-card-size', properties: { hidden: true, id: generateUuid() } });
		this.preview = h(document, container.localName === 'button' ? 'span' : 'div', { className: 'ash-file-card-preview' });
		const tag = h(document, 'span', { className: 'ash-file-card-format', properties: { id: generateUuid() } });
		const extension = extname(name).slice(1).toUpperCase();
		this._register(new Badge(tag, format ?? (extension || localize('files.cardFormat', 'FILE')), { presentation: 'outlined' }));
		this.descriptionIds = `${this.size.id} ${tag.id}`;
		container.append(title, this.size, this.preview, tag);
		this._register(toDisposable(() => {
			for (const element of [title, this.size, this.preview, tag]) element.remove();
		}));
	}

	setSize(bytes: number | undefined): void {
		const label = bytes === undefined ? '' : ByteSize.formatSize(bytes);
		if (this.size.textContent !== label) this.size.textContent = label;
		this.size.hidden = bytes === undefined;
	}
}
