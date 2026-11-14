import { createImageEditorWebview } from '../../../browser/imageEditorWebview.js';
import type { ImageEditorCompletion } from '../../../common/imageEditorService.js';
import { createTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { IWebviewService } from '../../../../../contrib/webview/browser/webview.js';
const services = createTestComponentServices();
const completions: ImageEditorCompletion[] = [];
const html = `<button disabled>Send messages</button><output></output><script>
window.addEventListener('message', event => {
 if (event.source !== parent) return;
 if (event.data.type === 'initialize') { document.querySelector('button').disabled=false; parent.postMessage({type:'ready'}, '*'); }
 if (event.data.type === 'completed') {
  const result=document.createElement('p'); result.textContent=event.data.error ? 'rejected' : 'completed'; document.querySelector('output').append(result);
  if(event.data.error) parent.postMessage({type:'complete',result:{kind:'cancel'}}, '*');
 }
});
document.querySelector('button').onclick=()=>{
 for(const action of ['settings','drag','copyPath','retry','cancel']) parent.postMessage({type:'permission',action}, '*');
 parent.postMessage({type:'complete',result:{kind:'pin'}}, '*');
};
parent.postMessage({type:'initialize'}, '*');
</script>`;
const view = createImageEditorWebview(document, services.get(IWebviewService), 'Extension image editor', html, {}, async result => { completions.push(result); return false; });
declare global { interface Window { imageEditorMessageFixture: { completions(): readonly ImageEditorCompletion[]; }; } }
window.imageEditorMessageFixture = { completions: () => completions };
window.addEventListener('pagehide', () => { view.dispose(); services.dispose(); }, { once: true });
