/** Assemble already-rendered JPEG pages into a PDF. Dimensions use PDF points. */
export function createImagePdf(pages: readonly { width: number; height: number; bytes: Uint8Array; pixelWidth: number; pixelHeight: number; }[]): Uint8Array {
	const encode = (value: string) => new TextEncoder().encode(value);
	const chunks: Uint8Array[] = [encode('%PDF-1.4\n')], offsets = [0]; let length = chunks[0]!.length;
	const object = (id: number, parts: readonly Uint8Array[]) => { offsets[id] = length; for (const bytes of [encode(`${id} 0 obj\n`), ...parts, encode('\nendobj\n')]) { chunks.push(bytes); length += bytes.length; } };
	object(1, [encode('<< /Type /Catalog /Pages 2 0 R >>')]);
	object(2, [encode(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] >>`)]);
	for (const [index, page] of pages.entries()) {
		const id = 3 + index * 3, content = encode(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`);
		object(id, [encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`)]);
		object(id + 1, [encode(`<< /Length ${content.length} >>\nstream\n`), content, encode('\nendstream')]);
		object(id + 2, [encode(`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`), page.bytes, encode('\nendstream')]);
	}
	const start = length, count = offsets.length;
	chunks.push(encode(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`));
	const result = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0)); let position = 0; for (const bytes of chunks) { result.set(bytes, position); position += bytes.length; } return result;
}
