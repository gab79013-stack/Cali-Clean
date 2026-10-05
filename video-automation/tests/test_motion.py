"""High-production motion generator: duration, reading time, safe zones, overflow, determinism, contrast, empty frames."""

import copy
import hashlib
import json
import unittest
from pathlib import Path

import test_guards as guards

pipeline = guards.pipeline
ROOT = guards.ROOT
import motion  # noqa: E402

try:
    import PIL  # noqa: F401
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

BRAND = json.loads((ROOT / "config" / "brand.json").read_text(encoding="utf-8"))
TOPICS = json.loads((ROOT / "config" / "topics.json").read_text(encoding="utf-8"))
LANGS = ("en", "es")


def all_plans():
    for script in TOPICS["scripts"]:
        for lang in LANGS:
            yield script, lang, motion.build_plan(script, lang, BRAND, TOPICS["labels"])


class StructureAndCopyTests(unittest.TestCase):
    def test_every_script_is_hook_problem_tips_benefit_cta(self):
        for script in TOPICS["scripts"]:
            kinds = [scene["kind"] for scene in script["scenes"]]
            tips = kinds.count("tip")
            self.assertTrue(motion.MIN_TIPS <= tips <= motion.MAX_TIPS, script["id"])
            self.assertEqual(kinds, ["hook", "problem"] + ["tip"] * tips + ["benefit", "cta"])

    def test_word_counts(self):
        for script in TOPICS["scripts"]:
            for scene in script["scenes"]:
                for lang in LANGS:
                    with self.subTest(script=script["id"], kind=scene["kind"], lang=lang):
                        self.assertTrue(6 <= len(scene["headline"][lang].split()) <= 8)
                        self.assertTrue(12 <= len(scene["support"][lang].split()) <= 16)

    def test_copy_passes_brand_policy_and_invents_nothing(self):
        for script, lang, plan in all_plans():
            texts = [s[k] for s in plan["scenes"] for k in ("eyebrow", "headline", "support")]
            pipeline.validate_copy(texts, BRAND)
            joined = " ".join(texts).casefold()
            for fragment in motion.INVENTED_RESULT_FRAGMENTS:
                self.assertNotIn(fragment, joined)

    def test_invented_results_are_rejected(self):
        script = copy.deepcopy(TOPICS["scripts"][0])
        script["scenes"][5]["support"]["en"] = "Our customers say this routine works every single time for every home."
        with self.assertRaisesRegex(motion.MotionError, "testimonials or results"):
            motion.validate_script(script, "en")

    def test_cta_is_soft_and_official(self):
        for script, lang, plan in all_plans():
            final = plan["scenes"][-1]
            self.assertEqual(final["kind"], "cta")
            self.assertIn(BRAND["cta"][lang], final["headline"])
            self.assertIn("cali-clean.net", final["headline"])

    def test_wrong_structure_is_rejected(self):
        script = copy.deepcopy(TOPICS["scripts"][0])
        script["scenes"].insert(0, script["scenes"].pop(1))
        with self.assertRaisesRegex(motion.MotionError, "structure"):
            motion.validate_script(script, "en")


class DurationAndReadingTests(unittest.TestCase):
    def test_durations_scene_counts_and_frame_alignment(self):
        for script, lang, plan in all_plans():
            with self.subTest(script=script["id"], lang=lang):
                motion.validate_plan(plan)
                self.assertTrue(18.0 <= plan["duration_seconds"] <= 24.0)
                self.assertTrue(6 <= len(plan["scenes"]) <= 8)
                self.assertEqual(plan["fps"], 30)
                self.assertEqual(plan["total_frames"], round(plan["duration_seconds"] * 30))
                for scene in plan["scenes"]:
                    seconds = (scene["end_frame"] - scene["start_frame"]) / 30
                    self.assertTrue(2.0 <= seconds <= 3.5, (scene["kind"], seconds))

    def test_hook_lands_before_half_a_second(self):
        for script, lang, plan in all_plans():
            hook = plan["scenes"][0]
            self.assertEqual(hook["text_start"], 0.0)
            self.assertLess(hook["headline_done"], 0.5, (script["id"], lang))

    def test_every_scene_has_its_computed_reading_time(self):
        for script, lang, plan in all_plans():
            for scene in plan["scenes"]:
                need_head, need_all = motion.reading_need(scene["headline"], scene["support"])
                self.assertAlmostEqual(scene["reading"]["need_headline"], round(need_head, 3))
                self.assertAlmostEqual(scene["reading"]["need_all"], round(need_all, 3))
                self.assertGreaterEqual(scene["end"] - scene["text_start"] + 1e-6, max(need_head, need_all),
                                        (script["id"], lang, scene["kind"]))

    def test_copy_too_long_to_read_is_rejected(self):
        script = copy.deepcopy(TOPICS["scripts"][0])
        script["scenes"][1]["headline"]["en"] = "Random cleaning means doing the same work twice."
        script["scenes"][1]["support"]["en"] = "Dust falls onto clean floors whenever you start very low and then finish much higher up."
        with self.assertRaisesRegex(motion.MotionError, "needs .* to read"):
            motion.build_plan(script, "en", BRAND, TOPICS["labels"])

    def test_plans_are_deterministic(self):
        first = [plan for _, _, plan in all_plans()]
        second = [plan for _, _, plan in all_plans()]
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))


class ContrastTests(unittest.TestCase):
    def test_palette_contrast_meets_targets(self):
        for pair in motion.validate_contrast(BRAND):
            self.assertGreaterEqual(pair["ratio"], pair["min"], pair)
            if pair["text"] in {"headline", "support", "disclosure"}:
                self.assertGreaterEqual(pair["ratio"], 7.0)

    def test_low_contrast_palette_is_rejected(self):
        brand = copy.deepcopy(BRAND)
        brand["colors"]["sage"] = "#5c6d65"
        with self.assertRaisesRegex(motion.MotionError, "Contrast too low for support"):
            motion.validate_contrast(brand)

    def test_wcag_formula(self):
        self.assertAlmostEqual(motion.contrast_ratio((0, 0, 0), (255, 255, 255)), 21.0, places=1)
        self.assertAlmostEqual(motion.contrast_ratio((119, 119, 119), (255, 255, 255)), 4.48, places=2)


@unittest.skipUnless(HAS_PIL, "Pillow is required to lay out and rasterize frames")
class LayoutAndFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fonts = motion.Fonts(ROOT / "assets" / "manrope.woff2")
        cls.plan = motion.build_plan(TOPICS["scripts"][0], "en", BRAND, TOPICS["labels"])
        cls.renderer = motion.Renderer(cls.plan, BRAND, ROOT)

    def test_everything_stays_inside_reels_safe_zones(self):
        left, top, right, bottom = motion.SAFE
        self.assertGreaterEqual(top, 220)
        self.assertLessEqual(bottom, 1920 - 380)
        self.assertLessEqual(right, 1080 - 140)
        for script, lang, plan in all_plans():
            for scene in plan["scenes"]:
                layout = motion.layout_scene(scene, self.fonts, len(plan["scenes"]))
                for name, box in motion.layout_boxes(layout).items():
                    self.assertTrue(motion.inside(box, motion.SAFE), (script["id"], lang, scene["kind"], name, box))

    def test_no_text_overflow(self):
        for script, lang, plan in all_plans():
            for scene in plan["scenes"]:
                layout = motion.layout_scene(scene, self.fonts, len(plan["scenes"]))
                card = layout["card"]
                inner = card[2] - card[0] - 2 * motion.CARD_PAD
                self.assertLessEqual(len(layout["headline"]), motion.MAX_HEADLINE_LINES)
                self.assertLessEqual(len(layout["support"]), motion.MAX_SUPPORT_LINES)
                for kind, role, size in (("headline", "headline", layout["headline_size"]), ("support", "support", layout["support_size"])):
                    font = self.fonts.get(role, size)
                    rebuilt = " ".join(line.text for line in layout[kind])
                    self.assertEqual(rebuilt, scene[kind], "every word is laid out")
                    for line in layout[kind]:
                        self.assertLessEqual(font.getlength(line.text), inner, (script["id"], lang, line.text))
                        self.assertLessEqual(line.y + line.height, card[3])

    def test_overflowing_copy_is_rejected(self):
        scene = dict(self.plan["scenes"][1])
        scene["headline"] = " ".join(["Supercalifragilisticexpialidocious"] * 3)
        with self.assertRaises(motion.MotionError):
            motion.layout_scene(scene, self.fonts, 7)
        scene["headline"] = "word " * 40
        with self.assertRaisesRegex(motion.MotionError, "overflows"):
            motion.layout_scene(scene, self.fonts, 7)

    def test_text_sizes_are_large_and_weighted(self):
        layouts = self.renderer.layouts
        self.assertGreaterEqual(min(layout["headline_size"] for layout in layouts), 66)
        self.assertGreaterEqual(min(layout["support_size"] for layout in layouts), 38)
        font = self.fonts.get("headline", 90)
        self.assertEqual(font.get_variation_axes()[0]["name"], b"Weight")

    def test_frames_are_deterministic(self):
        other = motion.Renderer(self.plan, BRAND, ROOT)
        for index in (0, 14, 120, self.plan["scenes"][2]["start_frame"] + 4, self.plan["total_frames"] - 1):
            a = hashlib.sha256(self.renderer.frame(index).tobytes()).hexdigest()
            b = hashlib.sha256(other.frame(index).tobytes()).hexdigest()
            self.assertEqual(a, b, f"frame {index}")

    def test_no_empty_frames(self):
        for index in range(0, self.plan["total_frames"], 15):
            motion.assert_not_empty(self.renderer.frame(index), str(index))
        motion.assert_not_empty(self.renderer.frame(self.plan["total_frames"] - 1), "last")

    def test_empty_frame_detector_catches_blank_frames(self):
        from PIL import Image

        for color in ((0, 0, 0), (22, 78, 71), (255, 255, 255)):
            with self.assertRaisesRegex(motion.MotionError, "looks empty"):
                motion.assert_not_empty(Image.new("RGB", (1080, 1920), color), "blank")

    def test_first_frame_already_shows_the_hook(self):
        frame0 = self.renderer.frame(0)
        layout = self.renderer.layouts[0]
        line = layout["headline"][0]
        crop = frame0.crop((line.x, line.y, line.x + 200, line.y + line.height)).convert("L")
        self.assertGreater(max(crop.getdata()), 150, "first hook word is visible on frame 0")

    def test_rendered_text_background_meets_contrast(self):
        scene = self.plan["scenes"][2]
        frame = self.renderer.frame(scene["end_frame"] - 1)
        card = self.renderer.layouts[2]["card"]
        x0, y0, x1, y1 = card
        paper = motion.hex_rgb(BRAND["colors"]["paper"])
        sage = motion.hex_rgb(BRAND["colors"]["sage"])
        for x, y in ((x0 + 30, y1 - 20), (x1 - 30, y1 - 20), ((x0 + x1) // 2, y1 - 14)):
            bg = frame.getpixel((x, y))
            self.assertGreaterEqual(motion.contrast_ratio(paper, bg), 7.0, (x, y, bg))
            self.assertGreaterEqual(motion.contrast_ratio(sage, bg), 7.0, (x, y, bg))

    def test_every_frame_is_full_resolution_bgra(self):
        chunk = next(iter(self.renderer.frames()))
        self.assertEqual(len(chunk), 1080 * 1920 * 4)
        self.assertEqual(chunk[3], 255)

    def test_transitions_use_slide_wipe_and_scale(self):
        kinds = {scene["transition"] for scene in self.plan["scenes"][1:]}
        self.assertEqual(kinds, {"slide", "wipe", "scale"})
        for scene in self.plan["scenes"][1:]:
            mid = self.renderer.frame(scene["start_frame"] + 3)
            settled = self.renderer.frame(min(scene["end_frame"] - 1, scene["start_frame"] + 30))
            self.assertNotEqual(mid.tobytes(), settled.tobytes(), scene["transition"])

    def test_contact_sheet_has_at_least_eight_moments(self):
        target = Path(guards.tempfile.mkdtemp()) / "sheet.png"
        info = motion.contact_sheet(self.renderer, target)
        self.assertGreaterEqual(len(info["moments"]), 8)
        frames = [m["frame"] for m in info["moments"]]
        self.assertEqual(len(frames), len(set(frames)))
        self.assertIn(0, frames)
        self.assertTrue(any(f / 30 < 0.5 and m["label"] == "hook landed" for f, m in zip(frames, info["moments"])))
        from PIL import Image

        with Image.open(target) as sheet:
            self.assertGreater(sheet.width, 1000)
            self.assertGreater(sheet.height, 1000)


if __name__ == "__main__":
    unittest.main()
