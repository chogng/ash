import { createImageViewFrame } from '../../../browser/imageViewFrame.js';
import type { ImageViewCompletion } from '../../../common/imageView.js';

const completions: ImageViewCompletion[] = [];
const html = `<button>Send messages</button><output></output><script>
window.addEventListener('message', event => {
 if (event.source !== parent) return;
 if (event.data.type === 'initialize') parent.postMessage({type:'ready'}, '*');
 if (event.data.type === 'permissionResult' || event.data.type === 'completed') {
  const result=document.createElement('p'); result.textContent=event.data.type; document.querySelector('output').append(result);
 }
});
document.querySelector('button').onclick=()=>{
 for(const action of ['settings','drag','copyPath','retry','cancel']) parent.postMessage({type:'permission',action}, '*');
 parent.postMessage({type:'complete',result:{kind:'cancel'}}, '*');
};
parent.postMessage({type:'initialize'}, '*');
</script>`;
const view = createImageViewFrame(document, 'Image message fixture', html, {}, async result => {
	completions.push(result); return true;
}, () => { document.body.dataset.ready = 'true'; });

declare global {
	interface Window { imageViewMessageFixture: { completions(): readonly ImageViewCompletion[]; }; }
}
window.imageViewMessageFixture = { completions: () => completions };
window.addEventListener('pagehide', () => view.dispose(), { once: true });
