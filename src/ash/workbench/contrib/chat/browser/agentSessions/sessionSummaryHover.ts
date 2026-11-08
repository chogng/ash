import { h } from '../../../../../base/browser/dom.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import './media/sessionSummaryHover.css';

export interface ISessionSummaryHoverData {
	readonly title: string;
	readonly details: readonly string[];
	readonly detailsSourceKey?: string;
	readonly loadDetails?: (token: CancellationToken) => Promise<readonly string[]>;
}

/** Renders supplied session metadata inside the caller's managed hover. */
export class SessionSummaryHoverWidget {
	public readonly domNode: HTMLElement;

	constructor(private readonly document: Document, data?: ISessionSummaryHoverData, token?: CancellationToken) {
		this.domNode = h(document, 'div', { className: 'ash-session-summary-hover' });
		this.update(data, token);
	}

	public update(data: ISessionSummaryHoverData | undefined, token?: CancellationToken): void {
		if (!data) {
			this.domNode.replaceChildren();
			return;
		}
		const title = h(this.document, 'strong', { className: 'ash-session-summary-hover-title' }, data.title);
		this.domNode.replaceChildren(title);
		this.appendDetails(data.details);
		if (token && data.loadDetails) {
			void data.loadDetails(token).then(details => {
				if (!token.isCancellationRequested) {
					this.appendDetails(details);
				}
			}, () => { /* Metadata is optional when its source is unavailable. */ });
		}
	}

	private appendDetails(details: readonly string[]): void {
		// The Hover Accessible View reads textContent, so keep the rows separated in plain text too.
		for (const detail of details) {
			this.domNode.append('\n', h(this.document, 'div', detail));
		}
	}
}
