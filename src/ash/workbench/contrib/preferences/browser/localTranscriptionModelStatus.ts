import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/localTranscriptionModelControls.css';
import '../../../../base/browser/ui/aria/aria.css';
import { h } from '../../../../base/browser/dom.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { isModelPreparing, DictationModelState, type ILocalTranscriptionModelSnapshot, type IDictationModelStatus } from '../../../../platform/localTranscription/common/localTranscription.js';

/** Shows operation feedback alongside the inventory's model state. */
export class LocalTranscriptionModelStatus extends Disposable {
	readonly domNode: HTMLElement;
	private readonly text: HTMLElement;
	private readonly progress: HTMLProgressElement;
	constructor(container: HTMLElement) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-local-transcription-model-status';
		this.text = h(document, 'p');
		this.text.setAttribute('role', 'status');
		this.text.setAttribute('aria-atomic', 'true');
		this.progress = this._register(new ProgressBar(this.domNode, defaultProgressBarStyles)).element;
		this.progress.hidden = true;
		this.progress.setAttribute('aria-label', localize('dictation.model.progress', 'Voice model preparation'));
		this.domNode.append(this.text, this.progress);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}
	setMessage(message: string): void {
		this.domNode.classList.remove('ash-aria-live');
		this.text.textContent = message;
		this.progress.hidden = true;
	}
	render(snapshot: ILocalTranscriptionModelSnapshot): void {
		// The model row shows Ready. Keep the completion announcement for screen readers.
		this.domNode.classList.toggle('ash-aria-live', snapshot.status?.state === DictationModelState.Ready);
		this.text.textContent = snapshot.status ? modelProgressText(snapshot.status) : '';
		this.progress.hidden = !isModelPreparing(snapshot.status);
		// The transport reports bytes, not a total. An indeterminate bar never invents a percentage.
		this.progress.removeAttribute('value');
	}
}

export function modelProgressText(status: IDictationModelStatus): string {
	switch (status.state) {
		case DictationModelState.Checking: return localize('dictation.model.checking', 'Checking model files…');
		case DictationModelState.Downloading: return localize('dictation.model.downloading', 'Downloading {0}: {1} MiB', status.file, (status.downloadedBytes / (1024 * 1024)).toFixed(1));
		case DictationModelState.Loading: return localize('dictation.model.loading', 'Loading model…');
		case DictationModelState.Ready: return localize('dictation.model.ready', 'Model verified and ready to use.');
		case DictationModelState.Cancelled: return localize('dictation.model.cancelled', 'Model preparation cancelled.');
		case DictationModelState.Error: return localize('dictation.model.failed', 'Model preparation failed: {0}', status.error);
	}
}
