import { createImageViewFrame } from '../../../browser/imageViewFrame.js';
import type { ImageViewPermissionAction } from '../../../common/imageView.js';

const calls: ImageViewPermissionAction[] = [];
const waiting = new Map<ImageViewPermissionAction, (accepted: boolean) => void>();
const html = `<button data-action="settings">Open Settings</button>
<button data-action="drag">Drag application</button>
<button data-action="copyPath">Copy path</button>
<output></output>
<script>
window.addEventListener('message', event => {
	if (event.source !== parent) return;
	if (event.data.type === 'initialize') parent.postMessage({ type: 'ready' }, '*');
	if (event.data.type === 'permissionResult') {
		const result = document.createElement('p');
		result.textContent = event.data.action + ':' + (event.data.error || event.data.accepted);
		document.querySelector('output').append(result);
	}
});
document.addEventListener('click', event => {
	const action = event.target.dataset.action;
	if (action) parent.postMessage({ type: 'permission', action }, '*');
});
parent.postMessage({ type: 'initialize' }, '*');
</script>`;
const view = createImageViewFrame(document, 'Screen permission fixture', html, {}, async () => true,
	() => { document.body.dataset.ready = 'true'; }, async action => {
		calls.push(action);
		if (action === 'settings' || action === 'copyPath') return new Promise<boolean>(resolve => waiting.set(action, resolve));
		return true;
	});

declare global {
	interface Window {
		imageViewPermissionFixture: {
			calls(): readonly ImageViewPermissionAction[];
			release(action: ImageViewPermissionAction, accepted: boolean): void;
		};
	}
}
window.imageViewPermissionFixture = {
	calls: () => calls,
	release(action, accepted) { waiting.get(action)?.(accepted); waiting.delete(action); }
};
window.addEventListener('pagehide', () => view.dispose(), { once: true });
