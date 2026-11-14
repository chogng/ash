// Keep parser initialization and the embedded worker behind the first render request.
export { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
export { default as workerSource } from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
