"""Convert a local PDF or Office document to UTF-8 Markdown."""

import argparse
import sys
from pathlib import Path

from markitdown import MarkItDown


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    if args.file.suffix.lower() not in {".pdf", ".docx", ".pptx", ".xlsx"}:
        parser.error("expected a PDF, DOCX, PPTX or XLSX file")
    if not args.file.is_file():
        parser.error("expected a local file")
    sys.stdout.write(MarkItDown(enable_plugins=False).convert_local(args.file).markdown)
