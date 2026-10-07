import json


class Settings:
    def __init__(self):
        self.current = {"name": "default", "enabled": False}

    def reload(self, path):
        self.current = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(self.current.get("name"), str):
            raise ValueError("name must be a string")
