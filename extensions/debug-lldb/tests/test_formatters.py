from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch


SCRIPT = (Path(__file__).parents[1] / "src/formatters.py").read_text(encoding="utf-8")


class Value:
    def __init__(self, address, count):
        self.address = address
        self.count = count

    def GetLoadAddress(self):
        return self.address

    def GetType(self):
        return SimpleNamespace(GetName=lambda: "Aggregate")

    def GetValue(self):
        return None

    def GetNumChildren(self):
        return self.count


class RustSummaryTests(unittest.TestCase):
    def install(self, original):
        providers = SimpleNamespace(aggregate_field_summary=original)
        with patch.dict(sys.modules, {"lldb_providers": providers}):
            namespace = {}
            exec(SCRIPT, namespace)
            wrapper = providers.aggregate_field_summary
            exec(SCRIPT, namespace)
            self.assertIs(providers.aggregate_field_summary, wrapper)
        return providers

    def test_self_alias_terminates_and_normal_summaries_still_work(self):
        def summary(value, internal):
            if value.count:
                yield from providers.aggregate_field_summary(value, internal)
            else:
                yield "42"

        providers = self.install(summary)
        self.assertEqual(
            list(providers.aggregate_field_summary(Value(1, 1), {})), ["Aggregate"]
        )
        self.assertEqual(
            list(providers.aggregate_field_summary(Value(2, 0), {})), ["42"]
        )

    def test_wide_codeview_children_are_not_exhausted(self):
        visited = []

        def summary(value, internal):
            for index in range(value.count):
                visited.append(index)
                yield str(index)

        providers = self.install(summary)
        result = list(providers.aggregate_field_summary(Value(1, 2**32), {}))
        self.assertEqual(result, [*(str(index) for index in range(8)), "…"])
        self.assertEqual(visited, list(range(8)))

    def test_deep_graph_is_bounded_and_releases_traversal_state(self):
        visited = []

        def summary(value, internal):
            visited.append(value.address)
            yield from providers.aggregate_field_summary(
                Value(value.address + 1, 1), internal
            )

        providers = self.install(summary)
        for _ in range(2):
            self.assertEqual(
                list(providers.aggregate_field_summary(Value(1, 1), {})), ["Aggregate"]
            )
        self.assertEqual(visited, [*range(1, 9), *range(1, 9)])

    def test_large_branching_graph_has_a_shared_summary_budget(self):
        visited = []

        def summary(value, internal):
            visited.append(value.address)
            for index in range(8):
                yield str(
                    list(
                        providers.aggregate_field_summary(
                            Value(value.address * 8 + index, 8), internal
                        )
                    )
                )

        providers = self.install(summary)
        for _ in range(2):
            before = len(visited)
            list(providers.aggregate_field_summary(Value(1, 8), {}))
            self.assertEqual(len(visited) - before, 64)


if __name__ == "__main__":
    unittest.main()
