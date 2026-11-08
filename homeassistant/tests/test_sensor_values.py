"""Sensor value regressions without requiring a Home Assistant installation."""
import ast
from pathlib import Path
import unittest

source = Path(__file__).parents[1] / "custom_components/sparkdash/sensor.py"
tree = ast.parse(source.read_text())
helpers = ast.Module(
    body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("_dig", "_value")],
    type_ignores=[],
)
namespace = {}
exec(compile(helpers, str(source), "exec"), namespace)
value = namespace["_value"]


class DecodeValidityTest(unittest.TestCase):
    def test_completion_window_and_warmup(self):
        llm = {"available": True, "measurementValid": True,
               "generationTpsSource": "completed-window", "generationTps": 85.33}
        metrics = {"metrics": {"llm": [llm]}}
        llm["generationMeasurementValid"] = False
        self.assertIsNone(value(metrics, "llm_generation_tps"))
        llm["generationMeasurementValid"] = True
        self.assertEqual(value(metrics, "llm_generation_tps"), 85.33)
        llm["generationTps"] = 0
        self.assertEqual(value(metrics, "llm_generation_tps"), 0)
        llm["measurementValid"] = False
        self.assertIsNone(value(metrics, "llm_generation_tps"))

    def test_existing_backend_without_optional_flag(self):
        self.assertEqual(value({"metrics": {"llm": [{"generationTps": 90}]}}, "llm_generation_tps"), 90)


if __name__ == "__main__":
    unittest.main()
