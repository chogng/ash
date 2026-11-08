import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/localTranscriptionModelControls.css';
import '../../../../base/browser/ui/aria/aria.css';
import { h } from '../../../../base/browser/dom.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { isModelPreparing, DictationModelState, type ILocalTranscriptionModelSnapshot } from '../../../../platform/localTranscription/common/localTranscription.js';

/** Announces model preparation and shows errors that are not associated with a row. */
export class LocalTranscriptionModelStatus extends Disposable {
	readonly domNode: HTMLElement;
	private readonly text: HTMLElement;
	private readonly progress: ProgressBar;
	constructor(container: HTMLElement) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-local-transcription-model-status';
		this.text = h(document, 'p');
		this.text.setAttribute('role', 'status');
		this.text.setAttribute('aria-atomic', 'true');
		this.progress = this._register(new ProgressBar(this.domNode, defaultProgressBarStyles));
		this.progress.element.hidden = true;
		this.progress.element.setAttribute('aria-label', localize('dictation.model.progress', 'Voice model preparation'));
		this.domNode.append(this.text, this.progress.element);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}
	setMessage(message: string): void {
		this.domNode.classList.remove('ash-aria-live');
		this.text.textContent = message;
		this.progress.element.hidden = true;
	}
	render(snapshot: ILocalTranscriptionModelSnapshot): void {
		const preparing = isModelPreparing(snapshot.status);
		const cancelled = snapshot.status?.state === DictationModelState.Cancelled;
		// The row represents preparation and completion. Cancellation is announced on the row's state change.
		this.domNode.classList.toggle('ash-aria-live', preparing || cancelled || snapshot.status?.state === DictationModelState.Ready);
		const message = cancelled ? '' : modelProgressText(snapshot);
		if (this.text.textContent !== message) this.text.textContent = message;
		this.progress.element.hidden = !preparing;
		this.progress.value = modelDownloadProgress(snapshot);
	}
}

export function modelDownloadProgress({ status, downloadSizeBytes }: ILocalTranscriptionModelSnapshot): number | undefined {
	if (status?.state === DictationModelState.Downloading && status.packageDownloadedBytes !== undefined && downloadSizeBytes) {
		return Math.min(1, status.packageDownloadedBytes / downloadSizeBytes);
	}
	return undefined;
}

export function modelPreparationText(state: DictationModelState.Checking | DictationModelState.Downloading | DictationModelState.Loading, progress?: number): string {
	switch (state) {
		case DictationModelState.Checking: return localize('dictation.model.checking', 'Checking model files…');
		case DictationModelState.Downloading:
			return progress === undefined
				? localize('dictation.model.downloading', 'Downloading…')
				: localize('dictation.model.downloadingPercent', 'Downloading {0}%', Math.floor(progress * 100));
		case DictationModelState.Loading: return localize('dictation.model.loading', 'Loading model…');
	}
}

export function modelProgressText(snapshot: ILocalTranscriptionModelSnapshot): string {
	const status = snapshot.status;
	switch (status?.state) {
		case DictationModelState.Checking:
		case DictationModelState.Downloading:
		case DictationModelState.Loading: return modelPreparationText(status.state, modelDownloadProgress(snapshot));
		case DictationModelState.Ready: return localize('dictation.model.ready', 'Model verified and ready to use.');
		case DictationModelState.Cancelled: return localize('dictation.model.cancelled', 'Model preparation cancelled.');
		case DictationModelState.Error: return localize('dictation.model.failed', 'Model preparation failed: {0}', status.error);
		case undefined: return '';
	}
}
