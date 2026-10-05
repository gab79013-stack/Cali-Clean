import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "src" / "pipeline.py")
pipeline = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = pipeline
SPEC.loader.exec_module(pipeline)


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.brand = pipeline.load_json(ROOT / "config" / "brand.json")
        cls.topics = pipeline.load_json(ROOT / "config" / "topics.json")
        cls.runtime = pipeline.load_json(ROOT / "config" / "runtime.json")

    def test_brand_snapshot_and_hashes_validate(self):
        pipeline.validate_brand(self.brand)

    def test_runtime_is_fail_closed(self):
        self.assertFalse(self.runtime["routine_enabled"])
        self.assertFalse(self.runtime["render_enabled"])
        self.assertFalse(self.runtime["publication_enabled"])
        self.assertFalse(self.runtime["meta_connected"])

    def test_plan_is_deterministic_and_language_controlled(self):
        slot = datetime(2026, 10, 4, 9, tzinfo=ZoneInfo("America/Los_Angeles"))
        first = pipeline.choose_plan(slot, self.brand, self.topics)
        second = pipeline.choose_plan(slot, self.brand, self.topics)
        self.assertEqual(first.draft_id, second.draft_id)
        self.assertIn(first.language, self.topics["language_cycle"])

    def test_storyboard_is_vertical_private_and_review_only(self):
        slot = datetime(2026, 10, 4, 9, tzinfo=ZoneInfo("America/Los_Angeles"))
        plan = pipeline.choose_plan(slot, self.brand, self.topics)
        draft = pipeline.build_storyboard(plan, self.brand, self.runtime)
        self.assertEqual(draft["output"]["width"], 1080)
        self.assertEqual(draft["output"]["height"], 1920)
        self.assertFalse(draft["publication"]["enabled"])
        self.assertEqual(draft["publication"]["destinations"], [])
        self.assertTrue(draft["review"]["required"])
        self.assertTrue(6 <= len(draft["scenes"]) <= 8)
        self.assertEqual(draft["output"]["fps"], 30)
        self.assertTrue(18 <= draft["output"]["duration_seconds"] <= 24)
        self.assertEqual([s["kind"] for s in draft["scenes"]][:2], ["hook", "problem"])
        self.assertEqual(draft["scenes"][-1]["kind"], "cta")

    def test_unsupported_claims_are_rejected(self):
        with self.assertRaises(pipeline.PolicyError):
            pipeline.validate_copy(["Five-star guaranteed cleaning"], self.brand)
        with self.assertRaises(pipeline.PolicyError):
            pipeline.validate_copy(["Antes y después con 100% garantía"], self.brand)

    def test_contact_details_and_prices_are_rejected(self):
        with self.assertRaises(pipeline.PolicyError):
            pipeline.validate_copy(["Call 619-555-1212"], self.brand)
        with self.assertRaises(pipeline.PolicyError):
            pipeline.validate_copy(["Email person@example.com"], self.brand)
        with self.assertRaises(pipeline.PolicyError):
            pipeline.validate_copy(["Only $99"], self.brand)

    def test_private_writer_uses_0600(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "private" / "draft.json"
            pipeline.write_json_private(path, {"ok": True})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_no_meta_client_or_publishing_code(self):
        source = (ROOT / "src" / "pipeline.py").read_text(encoding="utf-8").casefold()
        self.assertNotIn("graph.facebook", source)
        self.assertNotIn("publish_video", source)
        self.assertNotIn("instagram_content_publish", source)

    def test_hourly_entrypoint_stays_disabled(self):
        script = (ROOT / "scripts" / "run-hourly").read_text(encoding="utf-8")
        self.assertIn("VIDEO_ROUTINE_ENABLED", script)
        self.assertIn("exit 78", script)

    def test_all_scripts_use_official_services_and_valid_copy(self):
        official = {"commercial", "office", "residential", "medical-office", "industrial", "windows", "moving", "post-construction"}
        self.assertGreaterEqual(len(self.topics["scripts"]), 4)
        for script in self.topics["scripts"]:
            self.assertIn(script["service"], official)
            for lang in ("en", "es"):
                pipeline.validate_copy(
                    [script["title"][lang]] + [scene[k][lang] for scene in script["scenes"] for k in ("headline", "support")],
                    self.brand,
                )


if __name__ == "__main__":
    unittest.main()
