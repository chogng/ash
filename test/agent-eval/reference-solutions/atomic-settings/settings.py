import json


class Settings:
    def __init__(self):
        self.current = {"name": "default", "enabled": False}

    def reload(self, path):
        candidate = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(candidate, dict)
            or set(candidate) != {"name", "enabled"}
            or not isinstance(candidate["name"], str)
            or not isinstance(candidate["enabled"], bool)
        ):
            raise ValueError("invalid settings")
        self.current = candidate
