from __future__ import annotations

import sys
import unittest

import format as formatting


class FormatterTests(unittest.TestCase):
    def test_utf8_diagnostics_preserve_the_formatter_failure(self) -> None:
        diagnostic = "格式检查：未对齐 → 请修复\n"
        command = formatting.Command(
            "Example",
            (
                sys.executable,
                "-c",
                f"import sys; sys.stdout.buffer.write({diagnostic.encode('utf-8')!r}); sys.exit(2)",
            ),
        )

        self.assertEqual(formatting.run(command), ("Example", 2, diagnostic))


if __name__ == "__main__":
    unittest.main()
