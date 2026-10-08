from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "templates" / "manifest.example.yaml"


def test_example_pipeline(tmp_path):
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "vifont.py"), "all", str(MANIFEST), "--out", str(tmp_path)],
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert (tmp_path / "VariableIcons.ttf").exists()
    assert (tmp_path / "VariableIcons.woff2").exists()
    report = json.loads((tmp_path / "validation.json").read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert (tmp_path / "preview" / "folder" / "ANIM-050.svg").exists()
