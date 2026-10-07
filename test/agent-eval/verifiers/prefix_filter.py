import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("app", Path(sys.argv[1]) / "app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
for names, prefix, expected in [
    (["Alpha", "alpine", "Beta", "AL", ""], "al", ["Alpha", "alpine", "AL"]),
    (["", "Alpha", "北京", "😀"], "", ["", "Alpha", "北京", "😀"]),
    (["北京", "上海", "北京站"], "北京", ["北京", "北京站"]),
    ([], "anything", []),
    (["None", "none"], "x", []),
]:
    assert app.select_names(names, prefix) == expected, (names, prefix)
