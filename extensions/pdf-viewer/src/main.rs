fn main() {
    if external_ext_sdk::run_stdio(ash_pdf_viewer::PdfViewerExtension).is_err() {
        std::process::exit(1);
    }
}
