"""The search gate must discover new consumers instead of maintaining a product allowlist."""

import unittest

from check_search import search_packages


class SearchConsumerTests(unittest.TestCase):
    def test_discovers_renamed_and_test_only_dependencies_without_selecting_unrelated_crates(
        self,
    ):
        packages = [
            {"id": "grep", "name": "ash-grep", "dependencies": []},
            {"id": "paths", "name": "ash-file-search", "dependencies": []},
            {
                "id": "files",
                "name": "ash-files",
                "dependencies": [
                    {"name": "ash-file-search", "rename": "paths", "kind": None},
                ],
            },
            {
                "id": "new",
                "name": "new-consumer",
                "dependencies": [
                    {"name": "ash-grep", "kind": "dev"},
                ],
            },
            {"id": "unrelated", "name": "unrelated", "dependencies": []},
            {
                "id": "foreign",
                "name": "foreign",
                "dependencies": [{"name": "ash-grep"}],
            },
        ]
        metadata = {
            "packages": packages,
            "workspace_members": [p["id"] for p in packages[:-1]],
        }
        self.assertEqual(
            search_packages(metadata),
            ["ash-file-search", "ash-files", "ash-grep", "new-consumer"],
        )

    def test_rejects_missing_search_owners(self):
        with self.assertRaisesRegex(ValueError, "search APIs are missing"):
            search_packages({"packages": [], "workspace_members": []})
