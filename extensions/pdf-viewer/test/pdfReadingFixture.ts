import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { createCanvas } = createRequire(resolve('extensions/pdf-viewer/package.json'))(
	'@napi-rs/canvas',
) as typeof import('@napi-rs/canvas');

/** Text, vector chart and raster-only pages for the same PDF read by unit and Desktop tests. */
export function pdfReadingFixture(rotation = 0): Buffer {
	const scan = createCanvas(280, 180);
	const context = scan.getContext('2d');
	context.fillStyle = 'white';
	context.fillRect(0, 0, 280, 180);
	context.fillStyle = '#c83228';
	context.fillRect(20, 30, 90, 90);
	context.fillStyle = 'black';
	context.font = '20px sans-serif';
	context.fillText('SCANNED VALUE 73', 20, 155);
	const jpeg = scan.toBuffer('image/jpeg');
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	const streams = [
		'BT /F1 24 Tf 40 450 Td (Revenue: 42 million) Tj /F1 16 Tf 0 -50 Td (Forecast: 55 million) Tj 0 -50 Td (Use physical PDF page numbers.) Tj ET',
		'BT /F1 20 Tf 40 450 Td (Regional revenue chart) Tj ET 0.1 0.3 0.8 rg 50 100 80 200 re f 0.9 0.7 0.1 rg 170 100 80 300 re f',
		'q 280 0 0 180 40 220 cm /Im1 Do Q',
	];
	for (const [index, stream] of streams.entries()) {
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 520] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> ${index === 2 ? '/XObject << /Im1 10 0 R >>' : ''} >> /Contents ${5 + index * 2} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}
	objects.push(
		`<< /Type /XObject /Subtype /Image /Width 280 /Height 180 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg.toString('latin1')}\nendstream`,
	);
	let text = '%PDF-1.4\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(text.length);
		text += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const start = text.length;
	text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
		.join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(text, 'latin1');
}
