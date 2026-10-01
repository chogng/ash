import './media/localTranscriptionModelControls.css';
import { h } from '../../../../base/browser/dom.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { isModelPreparing, LocalTranscriptionModelState, type ILocalTranscriptionModelSnapshot, type ILocalTranscriptionModelStatus } from '../../../../platform/localTranscription/common/localTranscription.js';

/** The same backend snapshot is presented by settings and the composer. No view owns the task. */
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
		this.progress = this._register(new ProgressBar(this.domNode)).element;
		this.progress.hidden = true;
		this.progress.setAttribute('aria-label', localize('dictation.model.progress', 'Voice model preparation'));
		this.domNode.append(this.text, this.progress);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}
	setMessage(message: string): void { this.text.textContent = message; this.progress.hidden = true; }
	render(snapshot: ILocalTranscriptionModelSnapshot): void {
		this.text.textContent = snapshot.status ? modelProgressText(snapshot.status) : snapshot.available
			? localize('dictation.model.installedSize', 'Installed: {0} · {1} MiB', snapshot.model, (snapshot.sizeBytes / (1024 * 1024)).toFixed(1))
			: localize('dictation.model.missing', 'Model package not installed: {0}', snapshot.model);
		this.progress.hidden = !isModelPreparing(snapshot.status);
		// The transport reports bytes, not a total. An indeterminate bar never invents a percentage.
		this.progress.removeAttribute('value');
	}
}

export function modelProgressText(status: ILocalTranscriptionModelStatus): string {
	switch (status.state) {
		case LocalTranscriptionModelState.Checking: return localize('dictation.model.checking', 'Checking model files…');
		case LocalTranscriptionModelState.Downloading: return localize('dictation.model.downloading', 'Downloading {0}: {1} MiB', status.file, (status.downloadedBytes / (1024 * 1024)).toFixed(1));
		case LocalTranscriptionModelState.Loading: return localize('dictation.model.loading', 'Loading model…');
		case LocalTranscriptionModelState.Ready: return localize('dictation.model.ready', 'Model verified and ready to use.');
		case LocalTranscriptionModelState.Cancelled: return localize('dictation.model.cancelled', 'Model preparation cancelled.');
		case LocalTranscriptionModelState.Error: return localize('dictation.model.failed', 'Model preparation failed: {0}', status.error);
	}
}
