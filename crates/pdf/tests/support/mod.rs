pub fn fixture(rotation: u16) -> Vec<u8> {
    let stream = "BT /F1 18 Tf 30 220 Td (aspdf native review) Tj ET";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate {rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
        format!(
            "<< /Length {} >>\nstream\n{stream}\nendstream",
            stream.len()
        ),
    ];
    let mut text = "%PDF-1.4\n".to_owned();
    let mut offsets = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(text.len());
        text.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
    }
    let start = text.len();
    text.push_str("xref\n0 6\n0000000000 65535 f \n");
    for offset in offsets.into_iter().skip(1) {
        text.push_str(&format!("{offset:010} 00000 n \n"));
    }
    text.push_str(&format!(
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n"
    ));
    text.into_bytes()
}
