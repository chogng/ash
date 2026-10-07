import importlib.util
import json
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("settings", Path(sys.argv[1]) / "settings.py")
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "settings.json"
    store = settings.Settings()
    for invalid in ['{"name":"changed","enabled":"yes"}', '{"name":null,"enabled":false}', '{"name":"extra","enabled":true,"other":1}', '{"name":"missing"}', '[]', 'null', '{']:
        before = dict(store.current)
        path.write_text(invalid, encoding="utf-8")
        try:
            store.reload(path)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid settings accepted: {invalid}")
        assert store.current == before, invalid
    expected = {"name": "北京😀", "enabled": True}
    path.write_text(json.dumps(expected), encoding="utf-8")
    store.reload(path)
    assert store.current == expected
