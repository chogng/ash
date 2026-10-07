import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("document", Path(sys.argv[1]) / "document.py")
document = importlib.util.module_from_spec(spec)
spec.loader.exec_module(document)
for text, expected in [("", 1), ("hello", 1), ("a\n", 2), ("a\r", 2), ("a\r\n", 2), ("a\r\nb\rc\n", 4), ("\r\n\n\r", 4), ("北京😀\r\n東京", 2), ("\n\n", 3)]:
    assert document.line_count(text) == expected, repr(text)
