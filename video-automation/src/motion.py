"""High-production vertical motion generator for Cali Clean drafts.

Deterministic and offline. A script (hook, problem, 3-5 tips, benefit, soft CTA)
becomes a timed plan, a layout inside Reels safe zones, and 1080x1920 BGRA
frames that are streamed to the local AVFoundation encoder.

The planning half (timing, reading model, validation) is pure Python. Layout and
rasterization need Pillow and are imported lazily.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

WIDTH, HEIGHT, FPS = 1080, 1920, 30
MIN_TOTAL_SECONDS, MAX_TOTAL_SECONDS = 18.0, 24.0
MIN_SCENES, MAX_SCENES = 6, 8
MIN_SCENE_SECONDS, MAX_SCENE_SECONDS = 2.0, 3.5
MIN_TIPS, MAX_TIPS = 3, 5
HEADLINE_WORDS = (6, 8)
SUPPORT_WORDS = (12, 16)
HOOK_DEADLINE_SECONDS = 0.5

# Reading model (documented in README): the headline must be readable at
# 200 wpm and the whole card (headline + support) at a 400 wpm skim rate, plus
# a short orientation pause, all measured from the moment text starts entering.
HEADLINE_WPS = 200 / 60
SKIM_WPS = 400 / 60
ORIENTATION_SECONDS = 0.25
HOLD_SECONDS = 0.10

# Motion timing.
TRANSITION_SECONDS = 0.28
TEXT_OFFSET_SECONDS = 0.12
WORD_STAGGER = 0.05
HOOK_WORD_STAGGER = 0.035
# The hook animation starts slightly before frame 0, so the first frame already reads.
HOOK_PREROLL_SECONDS = 0.12
WORD_IN_SECONDS = 0.22
SUPPORT_DELAY_SECONDS = 0.30
LINE_STAGGER = 0.08
LINE_IN_SECONDS = 0.26
TRANSITIONS = ("slide", "wipe", "scale")

# Reels safe zone: clear of the top status/camera area, the right action rail
# and the bottom caption/CTA area. (left, top, right, bottom)
SAFE = (84, 240, 930, 1500)
MIN_TEXT_CONTRAST = 7.0
MIN_ACCENT_CONTRAST = 4.5

SCENE_KINDS = ("hook", "problem", "tip", "benefit", "cta")
ICONS = ("spark", "alert", "check", "timer", "drop", "wind", "home", "arrow", "plug", "layers", "box", "shield", "sun", "ladder")
# Phrases that would imply testimonials or promised results.
INVENTED_RESULT_FRAGMENTS = (
    "customers say", "clients say", "reviews", "rated", "results guaranteed", "proven",
    "clientes dicen", "reseñas", "resultados garantizados", "comprobado", "%",
)


class MotionError(ValueError):
    pass


def words(text: str) -> List[str]:
    return text.split()


def frames_for(seconds: float) -> int:
    return int(math.ceil(round(seconds * FPS, 6)))


def ease_out_cubic(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def ease_in_out(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


# --- Planning -------------------------------------------------------------------------


@dataclass(frozen=True)
class SceneTiming:
    start_frame: int
    end_frame: int
    text_start: float
    headline_done: float
    need_headline: float
    need_all: float

    @property
    def start(self) -> float:
        return self.start_frame / FPS

    @property
    def end(self) -> float:
        return self.end_frame / FPS

    @property
    def duration(self) -> float:
        return (self.end_frame - self.start_frame) / FPS

    @property
    def available(self) -> float:
        return self.end - self.text_start


def reading_need(headline: str, support: str) -> Tuple[float, float]:
    head = len(words(headline)) / HEADLINE_WPS
    full = ORIENTATION_SECONDS + (len(words(headline)) + len(words(support))) / SKIM_WPS
    return head, full


def validate_script(script: Dict[str, Any], lang: str) -> None:
    scenes = script["scenes"]
    kinds = [scene["kind"] for scene in scenes]
    tips = kinds.count("tip")
    if not MIN_SCENES <= len(scenes) <= MAX_SCENES:
        raise MotionError(f"{script['id']}: {len(scenes)} scenes; expected {MIN_SCENES}-{MAX_SCENES}")
    if not MIN_TIPS <= tips <= MAX_TIPS:
        raise MotionError(f"{script['id']}: {tips} tips; expected {MIN_TIPS}-{MAX_TIPS}")
    expected = ["hook", "problem"] + ["tip"] * tips + ["benefit", "cta"]
    if kinds != expected:
        raise MotionError(f"{script['id']}: structure must be hook, problem, tips, benefit, cta; got {kinds}")
    for scene in scenes:
        headline, support = scene["headline"][lang], scene["support"][lang]
        if not HEADLINE_WORDS[0] <= len(words(headline)) <= HEADLINE_WORDS[1]:
            raise MotionError(f"{script['id']}/{scene['kind']}/{lang}: headline has {len(words(headline))} words: {headline!r}")
        if not SUPPORT_WORDS[0] <= len(words(support)) <= SUPPORT_WORDS[1]:
            raise MotionError(f"{script['id']}/{scene['kind']}/{lang}: support has {len(words(support))} words: {support!r}")
        if scene.get("icon") not in ICONS:
            raise MotionError(f"{script['id']}/{scene['kind']}: unknown icon {scene.get('icon')!r}")
        lowered = f"{headline} {support}".casefold()
        for fragment in INVENTED_RESULT_FRAGMENTS:
            if fragment in lowered:
                raise MotionError(f"{script['id']}/{lang}: implies testimonials or results ({fragment!r})")


def plan_timings(scenes: Sequence[Dict[str, str]]) -> List[SceneTiming]:
    """Frame-aligned scene timings that satisfy the reading model and duration limits."""
    frames: List[int] = []
    needs: List[Tuple[float, float, float]] = []
    for index, scene in enumerate(scenes):
        offset = 0.0 if index == 0 else TEXT_OFFSET_SECONDS
        need_head, need_all = reading_need(scene["headline"], scene["support"])
        raw = offset + max(need_head, need_all)
        if raw > MAX_SCENE_SECONDS:
            raise MotionError(
                f"Scene {index + 1} ({scene['kind']}) needs {raw:.2f}s to read; max is {MAX_SCENE_SECONDS}s. Shorten the copy."
            )
        frames.append(frames_for(max(MIN_SCENE_SECONDS, raw)))
        needs.append((offset, need_head, need_all))
    total = sum(frames)
    max_scene_frames = int(MAX_SCENE_SECONDS * FPS)
    max_total_frames = int(MAX_TOTAL_SECONDS * FPS)
    # Optional breathing room after the reading time, only while the piece still fits.
    hold = frames_for(HOLD_SECONDS)
    for index in range(len(frames)):
        extra = min(hold, max_scene_frames - frames[index], max_total_frames - total)
        if extra > 0:
            frames[index] += extra
            total += extra
    # Pad short pieces from the end (CTA first) up to the minimum total duration.
    order = list(range(len(frames) - 1, -1, -1))
    while total < frames_for(MIN_TOTAL_SECONDS):
        grown = False
        for index in order:
            if frames[index] < max_scene_frames and total < frames_for(MIN_TOTAL_SECONDS):
                frames[index] += 1
                total += 1
                grown = True
        if not grown:
            raise MotionError("Cannot reach the minimum total duration with these scenes")
    if total > int(MAX_TOTAL_SECONDS * FPS):
        raise MotionError(f"Total duration {total / FPS:.2f}s exceeds {MAX_TOTAL_SECONDS}s")
    timings: List[SceneTiming] = []
    cursor = 0
    for index, (count, (offset, need_head, need_all)) in enumerate(zip(frames, needs)):
        start = cursor / FPS
        text_start = start + offset
        stagger = HOOK_WORD_STAGGER if index == 0 else WORD_STAGGER
        preroll = HOOK_PREROLL_SECONDS if index == 0 else 0.0
        headline_done = text_start + (len(words(scenes[index]["headline"])) - 1) * stagger + WORD_IN_SECONDS - preroll
        timings.append(SceneTiming(cursor, cursor + count, round(text_start, 6), round(headline_done, 6), need_head, need_all))
        cursor += count
    return timings


def build_plan(script: Dict[str, Any], lang: str, brand: Dict[str, Any], labels: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    validate_script(script, lang)
    tips_total = sum(1 for scene in script["scenes"] if scene["kind"] == "tip")
    scenes: List[Dict[str, Any]] = []
    tip_number = 0
    for index, source in enumerate(script["scenes"]):
        kind = source["kind"]
        if kind == "tip":
            tip_number += 1
            eyebrow = labels[lang]["tip"].format(n=tip_number, total=tips_total)
        elif kind == "hook":
            eyebrow = script["title"][lang].upper()
        else:
            eyebrow = labels[lang][kind]
        scenes.append({
            "index": index,
            "kind": kind,
            "eyebrow": eyebrow,
            "headline": source["headline"][lang],
            "support": source["support"][lang],
            "icon": source["icon"],
            "transition": "cut" if index == 0 else TRANSITIONS[(index - 1) % len(TRANSITIONS)],
            "tip_number": tip_number if kind == "tip" else None,
        })
    timings = plan_timings(scenes)
    for scene, timing in zip(scenes, timings):
        scene.update({
            "start": round(timing.start, 6),
            "end": round(timing.end, 6),
            "start_frame": timing.start_frame,
            "end_frame": timing.end_frame,
            "text_start": timing.text_start,
            "headline_done": timing.headline_done,
            "reading": {
                "need_headline": round(timing.need_headline, 3),
                "need_all": round(timing.need_all, 3),
                "available": round(timing.available, 3),
            },
        })
    total_frames = timings[-1].end_frame
    return {
        "script_id": script["id"],
        "service": script["service"],
        "asset_id": script["asset"],
        "language": lang,
        "fps": FPS,
        "width": WIDTH,
        "height": HEIGHT,
        "total_frames": total_frames,
        "duration_seconds": round(total_frames / FPS, 6),
        "scenes": scenes,
        "disclosure": brand["content_rules"]["required_visual_disclosure"][lang],
        "cta_url": "cali-clean.net",
    }


def validate_plan(plan: Dict[str, Any]) -> None:
    scenes = plan["scenes"]
    if not MIN_SCENES <= len(scenes) <= MAX_SCENES:
        raise MotionError("Scene count out of range")
    if not MIN_TOTAL_SECONDS <= plan["duration_seconds"] <= MAX_TOTAL_SECONDS:
        raise MotionError(f"Duration {plan['duration_seconds']}s out of range")
    cursor = 0
    for scene in scenes:
        if scene["start_frame"] != cursor:
            raise MotionError("Scenes must be contiguous and frame aligned")
        seconds = (scene["end_frame"] - scene["start_frame"]) / FPS
        if not MIN_SCENE_SECONDS - 1e-9 <= seconds <= MAX_SCENE_SECONDS + 1e-9:
            raise MotionError(f"Scene {scene['index'] + 1} lasts {seconds:.2f}s")
        reading = scene["reading"]
        if reading["available"] + 1e-6 < max(reading["need_headline"], reading["need_all"]):
            raise MotionError(f"Scene {scene['index'] + 1} is too short to read")
        cursor = scene["end_frame"]
    if cursor != plan["total_frames"]:
        raise MotionError("Scene frames do not add up to the total")
    if scenes[0]["headline_done"] >= HOOK_DEADLINE_SECONDS:
        raise MotionError(f"Hook headline lands at {scenes[0]['headline_done']:.2f}s; must be before {HOOK_DEADLINE_SECONDS}s")


# --- Colour and contrast -------------------------------------------------------------


def hex_rgb(value: str) -> Tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def relative_luminance(rgb: Sequence[float]) -> float:
    def channel(c: float) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: Sequence[float], b: Sequence[float]) -> float:
    la, lb = sorted((relative_luminance(a), relative_luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def composite(fg: Sequence[int], alpha: float, bg: Sequence[int]) -> Tuple[float, float, float]:
    return tuple(fg[i] * alpha + bg[i] * (1 - alpha) for i in range(3))


CARD_ALPHA = 0.94
DISCLOSURE_ALPHA = 0.90


def palette(brand: Dict[str, Any]) -> Dict[str, Tuple[int, int, int]]:
    return {key: hex_rgb(value) for key, value in brand["colors"].items()}


def contrast_pairs(brand: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every text/background pair, with the card evaluated over worst-case white and black backgrounds."""
    colors = palette(brand)
    pairs = []
    for backdrop_name, backdrop in (("white", (255, 255, 255)), ("black", (0, 0, 0))):
        card = composite(colors["ink"], CARD_ALPHA, backdrop)
        band = composite(colors["ink"], DISCLOSURE_ALPHA, backdrop)
        pairs.extend([
            {"text": "headline", "fg": colors["paper"], "bg": card, "min": MIN_TEXT_CONTRAST, "over": backdrop_name},
            {"text": "support", "fg": colors["sage"], "bg": card, "min": MIN_TEXT_CONTRAST, "over": backdrop_name},
            {"text": "disclosure", "fg": colors["paper"], "bg": band, "min": MIN_TEXT_CONTRAST, "over": backdrop_name},
        ])
    pairs.extend([
        {"text": "eyebrow", "fg": colors["ink"], "bg": colors["orange"], "min": MIN_ACCENT_CONTRAST, "over": "opaque"},
        {"text": "url_pill", "fg": colors["ink"], "bg": colors["orange"], "min": MIN_ACCENT_CONTRAST, "over": "opaque"},
        {"text": "icon", "fg": colors["ink"], "bg": colors["sage"], "min": MIN_ACCENT_CONTRAST, "over": "opaque"},
    ])
    for pair in pairs:
        pair["ratio"] = round(contrast_ratio(pair["fg"], pair["bg"]), 2)
    return pairs


def validate_contrast(brand: Dict[str, Any]) -> List[Dict[str, Any]]:
    pairs = contrast_pairs(brand)
    for pair in pairs:
        if pair["ratio"] < pair["min"]:
            raise MotionError(f"Contrast too low for {pair['text']} over {pair['over']}: {pair['ratio']} < {pair['min']}")
    return pairs


# --- Layout (Pillow) --------------------------------------------------------------------

HEADLINE_SIZES = (96, 90, 84, 78, 72, 66)
SUPPORT_SIZES = (46, 44, 42, 40, 38)
MAX_HEADLINE_LINES = 4
MAX_SUPPORT_LINES = 4
CARD_PAD = 52
CARD_RADIUS = 40
ICON_SIZE = 128
WEIGHTS = {"headline": 800, "support": 600, "eyebrow": 800, "brand": 800, "small": 600, "url": 800, "label": 700}


class Fonts:
    def __init__(self, font_path: Path) -> None:
        self.font_path = font_path
        self._cache: Dict[Tuple[str, int], Any] = {}

    def get(self, role: str, size: int):
        key = (role, size)
        if key not in self._cache:
            from PIL import ImageFont

            font = ImageFont.truetype(str(self.font_path), size)
            font.set_variation_by_axes([WEIGHTS[role]])
            self._cache[key] = font
        return self._cache[key]


def check_dependencies(font_path: Path) -> str:
    import PIL
    from PIL import features

    fonts = Fonts(font_path)
    fonts.get("headline", 40)
    return f"Pillow {PIL.__version__}, FreeType {features.version('freetype2')}, Manrope variable weights OK"


def wrap(text: str, font, max_width: int) -> List[str]:
    lines: List[str] = []
    current = ""
    for word in words(text):
        candidate = f"{current} {word}".strip()
        if font.getlength(candidate) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            if font.getlength(word) > max_width:
                raise MotionError(f"Word too wide for the card: {word!r}")
            current = word
    if current:
        lines.append(current)
    return lines


@dataclass
class TextLine:
    text: str
    x: int
    y: int
    width: int
    height: int
    words: List[Tuple[str, int]]  # (word, x offset within line)


def layout_scene(scene: Dict[str, Any], fonts: Fonts, total_scenes: int) -> Dict[str, Any]:
    """Settled-state boxes for one scene, all inside SAFE."""
    left, top, right, bottom = SAFE
    card_w = right - left
    inner_w = card_w - 2 * CARD_PAD
    progress = (left, top, right, top + 12)
    brand_box = (left, top + 44, left + 420, top + 44 + 76)
    disclosure_box = (left, bottom - 96, right, bottom)

    eyebrow_font = fonts.get("eyebrow", 32)
    eyebrow_w = int(eyebrow_font.getlength(scene["eyebrow"])) + 48
    if eyebrow_w > inner_w - ICON_SIZE - 20:
        raise MotionError(f"Eyebrow too long: {scene['eyebrow']!r}")
    url_h = 96 if scene["kind"] == "cta" else 0
    region_top, region_bottom = brand_box[3] + 40, disclosure_box[1] - 40

    # Largest headline/support sizes whose wrapped lines fit both the line limits and the card height.
    fitted = None
    for head_size in HEADLINE_SIZES:
        head_lines = wrap(scene["headline"], fonts.get("headline", head_size), inner_w)
        if len(head_lines) > MAX_HEADLINE_LINES:
            continue
        for sup_size in SUPPORT_SIZES:
            sup_lines = wrap(scene["support"], fonts.get("support", sup_size), inner_w)
            if len(sup_lines) > MAX_SUPPORT_LINES:
                continue
            head_lh, sup_lh = int(head_size * 1.12), int(sup_size * 1.32)
            content_h = ICON_SIZE + 34 + len(head_lines) * head_lh + 30 + len(sup_lines) * sup_lh + (34 + url_h if url_h else 0)
            if content_h + 2 * CARD_PAD <= region_bottom - region_top:
                fitted = (head_size, head_lines, head_lh, sup_size, sup_lines, sup_lh, content_h + 2 * CARD_PAD)
                break
        if fitted:
            break
    if fitted is None:
        raise MotionError(f"Scene {scene['index'] + 1} text overflows the card at every allowed size")
    head_size, head_lines, head_lh, sup_size, sup_lines, sup_lh, card_h = fitted
    head_font, sup_font = fonts.get("headline", head_size), fonts.get("support", sup_size)
    card_top = region_top + (region_bottom - region_top - card_h) // 2
    card = (left, card_top, right, card_top + card_h)

    cx, cy = card[0] + CARD_PAD, card[1] + CARD_PAD
    eyebrow_box = (cx, cy + (ICON_SIZE - 60) // 2, cx + eyebrow_w, cy + (ICON_SIZE - 60) // 2 + 60)
    icon_box = (card[2] - CARD_PAD - ICON_SIZE, cy, card[2] - CARD_PAD, cy + ICON_SIZE)
    y = cy + ICON_SIZE + 34

    def lines_for(lines: List[str], font, lh: int, y0: int) -> List[TextLine]:
        out = []
        space = font.getlength(" ")
        for i, line in enumerate(lines):
            offsets, x = [], 0.0
            for word in line.split():
                offsets.append((word, int(round(x))))
                x += font.getlength(word) + space
            width = int(math.ceil(font.getlength(line)))
            out.append(TextLine(line, cx, y0 + i * lh, width, lh, offsets))
        return out

    head = lines_for(head_lines, head_font, head_lh, y)
    y += len(head_lines) * head_lh + 30
    sup = lines_for(sup_lines, sup_font, sup_lh, y)
    y += len(sup_lines) * sup_lh
    url_box = None
    if url_h:
        url_font = fonts.get("url", 48)
        url_w = int(url_font.getlength("cali-clean.net")) + 80
        url_box = (cx, y + 34, cx + url_w, y + 34 + url_h)
    return {
        "card": card,
        "eyebrow": eyebrow_box,
        "icon": icon_box,
        "headline": head,
        "support": sup,
        "headline_size": head_size,
        "support_size": sup_size,
        "url": url_box,
        "progress": progress,
        "brand": brand_box,
        "disclosure": disclosure_box,
        "total_scenes": total_scenes,
    }


def layout_boxes(layout: Dict[str, Any]) -> Dict[str, Tuple[int, int, int, int]]:
    boxes = {key: layout[key] for key in ("card", "eyebrow", "icon", "progress", "brand", "disclosure")}
    if layout["url"]:
        boxes["url"] = layout["url"]
    for kind in ("headline", "support"):
        for i, line in enumerate(layout[kind]):
            boxes[f"{kind}[{i}]"] = (line.x, line.y, line.x + line.width, line.y + line.height)
    return boxes


def inside(box: Sequence[int], outer: Sequence[int]) -> bool:
    return box[0] >= outer[0] and box[1] >= outer[1] and box[2] <= outer[2] and box[3] <= outer[3]


# --- Drawing ---------------------------------------------------------------------------


def draw_icon(name: str, size: int, fg: Tuple[int, int, int], bg: Tuple[int, int, int]):
    from PIL import Image, ImageDraw

    scale = 4
    s = size * scale
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    d.ellipse((0, 0, s - 1, s - 1), fill=bg + (255,))
    w = int(s * 0.075)
    c = s / 2
    r = s * 0.26
    fill = fg + (255,)

    def pts(*coords):
        return [(c + x * r, c + y * r) for x, y in coords]

    if name == "spark":
        d.polygon(pts((0, -1.25), (0.28, -0.28), (1.25, 0), (0.28, 0.28), (0, 1.25), (-0.28, 0.28), (-1.25, 0), (-0.28, -0.28)), fill=fill)
    elif name == "alert":
        d.line(pts((0, -1.1), (1.15, 0.95), (-1.15, 0.95), (0, -1.1)), fill=fill, width=w, joint="curve")
        d.line(pts((0, -0.4), (0, 0.3)), fill=fill, width=w)
        d.ellipse((c - w * 0.7, c + r * 0.55, c + w * 0.7, c + r * 0.55 + w * 1.4), fill=fill)
    elif name == "check":
        d.line(pts((-0.95, 0.05), (-0.3, 0.7), (1.0, -0.65)), fill=fill, width=int(w * 1.3), joint="curve")
    elif name == "timer":
        d.ellipse((c - r * 1.05, c - r * 0.9, c + r * 1.05, c + r * 1.2), outline=fill, width=w)
        d.line(pts((0, 0.15), (0, -0.45)), fill=fill, width=w)
        d.line(pts((0, 0.15), (0.45, 0.4)), fill=fill, width=w)
        d.line(pts((-0.35, -1.25), (0.35, -1.25)), fill=fill, width=w)
    elif name == "drop":
        d.polygon(pts((0, -1.25), (0.8, 0.1), (-0.8, 0.1)), fill=fill)
        d.ellipse((c - r * 0.82, c - r * 0.25, c + r * 0.82, c + r * 1.25), fill=fill)
    elif name == "wind":
        for dy, length in ((-0.6, 1.0), (0.0, 1.3), (0.6, 0.8)):
            d.line(pts((-1.1, dy), (-1.1 + length * 1.6, dy)), fill=fill, width=w)
        d.arc((c + r * 0.15, c - r * 1.05, c + r * 0.95, c - r * 0.15), 180, 90, fill=fill, width=w)
    elif name == "home":
        d.line(pts((-1.2, 0.0), (0, -1.05), (1.2, 0.0)), fill=fill, width=w, joint="curve")
        d.line(pts((-0.85, -0.25), (-0.85, 1.05), (0.85, 1.05), (0.85, -0.25)), fill=fill, width=w, joint="curve")
        d.rectangle((c - r * 0.25, c + r * 0.35, c + r * 0.25, c + r * 1.05), fill=fill)
    elif name == "arrow":
        d.line(pts((-1.1, 0), (0.9, 0)), fill=fill, width=int(w * 1.2))
        d.polygon(pts((1.25, 0), (0.35, -0.75), (0.35, 0.75)), fill=fill)
    elif name == "plug":
        d.rounded_rectangle((c - r * 0.75, c - r * 0.35, c + r * 0.75, c + r * 0.75), radius=int(r * 0.25), fill=fill)
        d.line(pts((-0.35, -0.35), (-0.35, -1.1)), fill=fill, width=w)
        d.line(pts((0.35, -0.35), (0.35, -1.1)), fill=fill, width=w)
        d.line(pts((0, 0.75), (0, 1.25)), fill=fill, width=w)
    elif name == "layers":
        for dy in (-0.55, 0.05, 0.65):
            d.line(pts((-1.1, dy), (0, dy - 0.5), (1.1, dy), (0, dy + 0.5), (-1.1, dy)), fill=fill, width=int(w * 0.8), joint="curve")
    elif name == "box":
        d.line(pts((0, -1.15), (1.05, -0.6), (1.05, 0.65), (0, 1.2), (-1.05, 0.65), (-1.05, -0.6), (0, -1.15)), fill=fill, width=w, joint="curve")
        d.line(pts((-1.05, -0.6), (0, -0.05), (1.05, -0.6)), fill=fill, width=w)
        d.line(pts((0, -0.05), (0, 1.2)), fill=fill, width=w)
    elif name == "shield":
        d.line(pts((0, -1.2), (1.0, -0.8), (0.9, 0.3), (0, 1.2), (-0.9, 0.3), (-1.0, -0.8), (0, -1.2)), fill=fill, width=w, joint="curve")
        d.line(pts((-0.45, 0.0), (-0.1, 0.35), (0.5, -0.35)), fill=fill, width=w)
    elif name == "sun":
        d.ellipse((c - r * 0.55, c - r * 0.55, c + r * 0.55, c + r * 0.55), fill=fill)
        for k in range(8):
            a = k * math.pi / 4
            d.line([(c + math.cos(a) * r * 0.85, c + math.sin(a) * r * 0.85), (c + math.cos(a) * r * 1.25, c + math.sin(a) * r * 1.25)], fill=fill, width=w)
    elif name == "ladder":
        d.line(pts((-0.6, -1.2), (-0.6, 1.2)), fill=fill, width=w)
        d.line(pts((0.6, -1.2), (0.6, 1.2)), fill=fill, width=w)
        for dy in (-0.75, -0.05, 0.65):
            d.line(pts((-0.6, dy), (0.6, dy)), fill=fill, width=w)
    else:
        raise MotionError(f"Unknown icon {name!r}")
    return image.resize((size, size), Image.LANCZOS)


class Renderer:
    """Renders plan frames deterministically. Static layers are prepared once per scene."""

    def __init__(self, plan: Dict[str, Any], brand: Dict[str, Any], root: Path) -> None:
        from PIL import Image

        self.plan = plan
        self.brand = brand
        self.root = root
        self.colors = palette(brand)
        self.fonts = Fonts(root / brand["font"]["asset"])
        self.scenes = plan["scenes"]
        self.layouts = [layout_scene(scene, self.fonts, len(self.scenes)) for scene in self.scenes]
        asset = next(item for item in brand["assets"] if item["id"] == plan["asset_id"])
        self.background = self._prepare_background(Image.open(root / asset["path"]).convert("RGB"))
        self.cards = [self._card_layer(scene, layout) for scene, layout in zip(self.scenes, self.layouts)]
        self.words = [self._word_sprites(layout) for layout in self.layouts]
        self.chrome = self._chrome_layer()
        self._settled_cache: Dict[int, Any] = {}

    # Static layers ------------------------------------------------------------------

    def _prepare_background(self, source):
        from PIL import Image

        # Cover-scale with margin for micro-parallax, then darken top/bottom for legibility.
        margin_x, margin_y = 120, 60
        target_h = HEIGHT + 2 * margin_y
        target_w = max(WIDTH + 2 * margin_x, int(source.width * target_h / source.height))
        scaled = source.resize((target_w, target_h), Image.LANCZOS)
        left = (target_w - (WIDTH + 2 * margin_x)) // 2
        scaled = scaled.crop((left, 0, left + WIDTH + 2 * margin_x, target_h))
        shade = Image.new("RGBA", scaled.size, self.colors["ink"] + (0,))
        alpha = Image.linear_gradient("L").resize((1, 256))
        ramp = [int(95 + 125 * abs((i / 255) - 0.42) / 0.58) for i in range(256)]
        alpha = alpha.point(lambda v: ramp[v]).resize(scaled.size)
        shade.putalpha(alpha)
        return Image.alpha_composite(scaled.convert("RGBA"), shade).convert("RGB")

    def _card_layer(self, scene, layout):
        from PIL import Image, ImageDraw

        x0, y0, x1, y1 = layout["card"]
        card = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        d = ImageDraw.Draw(card)
        d.rounded_rectangle((0, 0, card.width - 1, card.height - 1), radius=CARD_RADIUS, fill=self.colors["ink"] + (int(255 * CARD_ALPHA),))
        d.rounded_rectangle((0, 28, 12, card.height - 28), radius=6, fill=self.colors["orange"] + (255,))
        ex0, ey0, ex1, ey1 = (v - o for v, o in zip(layout["eyebrow"], (x0, y0, x0, y0)))
        eyebrow = Image.new("RGBA", (ex1 - ex0, ey1 - ey0), (0, 0, 0, 0))
        ed = ImageDraw.Draw(eyebrow)
        ed.rounded_rectangle((0, 0, eyebrow.width - 1, eyebrow.height - 1), radius=30, fill=self.colors["orange"] + (255,))
        font = self.fonts.get("eyebrow", 32)
        ed.text((24, eyebrow.height // 2), scene["eyebrow"], font=font, fill=self.colors["ink"] + (255,), anchor="lm")
        icon = draw_icon(scene["icon"], ICON_SIZE, self.colors["ink"], self.colors["sage"])
        if scene.get("tip_number"):
            badge = ImageDraw.Draw(icon)
            bfont = self.fonts.get("label", 32)
            badge.ellipse((ICON_SIZE - 48, ICON_SIZE - 48, ICON_SIZE - 2, ICON_SIZE - 2), fill=self.colors["orange"] + (255,))
            badge.text((ICON_SIZE - 25, ICON_SIZE - 25), str(scene["tip_number"]), font=bfont, fill=self.colors["ink"] + (255,), anchor="mm")
        url = None
        if layout["url"]:
            ux0, uy0, ux1, uy1 = (v - o for v, o in zip(layout["url"], (x0, y0, x0, y0)))
            url = Image.new("RGBA", (ux1 - ux0, uy1 - uy0), (0, 0, 0, 0))
            ud = ImageDraw.Draw(url)
            ud.rounded_rectangle((0, 0, url.width - 1, url.height - 1), radius=46, fill=self.colors["orange"] + (255,))
            ud.text((url.width // 2, url.height // 2), "cali-clean.net", font=self.fonts.get("url", 48), fill=self.colors["ink"] + (255,), anchor="mm")
            url = (url, (ux0, uy0))
        return {"base": card, "eyebrow": (eyebrow, (ex0, ey0)), "icon": (icon, (layout["icon"][0] - x0, layout["icon"][1] - y0)), "url": url}

    def _word_sprites(self, layout):
        from PIL import Image, ImageDraw

        x0, y0 = layout["card"][0], layout["card"][1]
        sprites = {"headline": [], "support": []}
        for kind, role, size, color in (
            ("headline", "headline", layout["headline_size"], self.colors["paper"]),
            ("support", "support", layout["support_size"], self.colors["sage"]),
        ):
            font = self.fonts.get(role, size)
            for line_index, line in enumerate(layout[kind]):
                if kind == "headline":
                    for word, offset in line.words:
                        w = int(math.ceil(font.getlength(word))) + 8
                        sprite = Image.new("RGBA", (w, line.height + 12), (0, 0, 0, 0))
                        ImageDraw.Draw(sprite).text((0, 4), word, font=font, fill=color + (255,))
                        sprites[kind].append((sprite, (line.x - x0 + offset, line.y - y0), line_index))
                else:
                    sprite = Image.new("RGBA", (line.width + 8, line.height + 12), (0, 0, 0, 0))
                    ImageDraw.Draw(sprite).text((0, 4), line.text, font=font, fill=color + (255,))
                    sprites[kind].append((sprite, (line.x - x0, line.y - y0), line_index))
        return sprites

    def _chrome_layer(self):
        from PIL import Image, ImageDraw

        layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        layout = self.layouts[0]
        bx0, by0, _, by1 = layout["brand"]
        font = self.fonts.get("brand", 62)
        d.text((bx0, (by0 + by1) // 2), "cali", font=font, fill=self.colors["paper"] + (255,), anchor="lm")
        d.text((bx0 + font.getlength("cali"), (by0 + by1) // 2), "clean", font=font, fill=self.colors["sage"] + (255,), anchor="lm")
        dx0, dy0, dx1, dy1 = layout["disclosure"]
        d.rounded_rectangle((dx0, dy0, dx1, dy1), radius=24, fill=self.colors["ink"] + (int(255 * DISCLOSURE_ALPHA),))
        small = self.fonts.get("small", 25)
        lines = wrap(self.plan["disclosure"], small, dx1 - dx0 - 48)
        if len(lines) > 2:
            raise MotionError("Disclosure overflows two lines")
        total = len(lines) * 32
        for i, line in enumerate(lines):
            d.text((dx0 + 24, (dy0 + dy1) // 2 - total // 2 + i * 32 + 16), line, font=small, fill=self.colors["paper"] + (255,), anchor="lm")
        return layer

    # Per-frame ----------------------------------------------------------------------

    def scene_at(self, frame_index: int) -> int:
        for index, scene in enumerate(self.scenes):
            if scene["start_frame"] <= frame_index < scene["end_frame"]:
                return index
        raise MotionError(f"Frame {frame_index} outside the plan")

    def _background(self, scene_index: int, t: float):
        scene = self.scenes[scene_index]
        span = max(1e-6, scene["end"] - scene["start"])
        p = ease_in_out((t - scene["start"]) / span)
        direction = 1 if scene_index % 2 == 0 else -1
        x = int(round(120 + direction * (-48 + 96 * p)))
        y = int(round(60 - 24 + 48 * p))
        return self.background.crop((x, y, x + WIDTH, y + HEIGHT)).convert("RGBA")

    def _card_image(self, scene_index: int, t: float):
        from PIL import Image

        scene = self.scenes[scene_index]
        layers = self.cards[scene_index]
        card = layers["base"].copy()
        u = t - scene["text_start"]
        e_in = ease_out_cubic(u / 0.2) if scene_index else 1.0
        eyebrow, (ex, ey) = layers["eyebrow"]
        card.alpha_composite(self._fade(eyebrow, e_in), (int(ex - 30 * (1 - e_in)), ey))
        icon, (ix, iy) = layers["icon"]
        pop = ease_out_cubic((t - scene["text_start"]) / 0.25) if scene_index else 1.0
        if pop < 1:
            size = max(1, int(ICON_SIZE * (0.6 + 0.4 * pop)))
            scaled = icon.resize((size, size), Image.BILINEAR)
            card.alpha_composite(self._fade(scaled, pop), (ix + (ICON_SIZE - size) // 2, iy + (ICON_SIZE - size) // 2))
        else:
            card.alpha_composite(icon, (ix, iy))
        stagger = HOOK_WORD_STAGGER if scene_index == 0 else WORD_STAGGER
        tw = t + (HOOK_PREROLL_SECONDS if scene_index == 0 else 0.0)
        for i, (sprite, (sx, sy), _) in enumerate(self.words[scene_index]["headline"]):
            a = ease_out_cubic((tw - scene["text_start"] - i * stagger) / WORD_IN_SECONDS)
            if a > 0:
                card.alpha_composite(self._fade(sprite, a), (sx, int(sy + 28 * (1 - a))))
        for sprite, (sx, sy), line in self.words[scene_index]["support"]:
            a = ease_out_cubic((tw - scene["text_start"] - SUPPORT_DELAY_SECONDS - line * LINE_STAGGER) / LINE_IN_SECONDS)
            if a > 0:
                card.alpha_composite(self._fade(sprite, a), (sx, int(sy + 18 * (1 - a))))
        if layers["url"]:
            url, (ux, uy) = layers["url"]
            a = ease_out_cubic((t - scene["text_start"] - 0.55) / 0.3)
            if a > 0:
                card.alpha_composite(self._fade(url, a), (ux, int(uy + 16 * (1 - a))))
        return card

    @staticmethod
    def _fade(image, alpha: float):
        if alpha >= 0.999:
            return image
        faded = image.copy()
        a = faded.getchannel("A").point(lambda v: int(v * alpha))
        faded.putalpha(a)
        return faded

    def _progress(self, frame, t: float) -> None:
        from PIL import ImageDraw

        d = ImageDraw.Draw(frame)
        x0, y0, x1, y1 = self.layouts[0]["progress"]
        n = len(self.scenes)
        gap = 10
        seg = (x1 - x0 - gap * (n - 1)) / n
        for i, scene in enumerate(self.scenes):
            sx0 = x0 + i * (seg + gap)
            sx1 = sx0 + seg
            d.rounded_rectangle((sx0, y0, sx1, y1), radius=6, fill=self.colors["paper"] + (80,))
            fill = min(1.0, max(0.0, (t - scene["start"]) / (scene["end"] - scene["start"])))
            if fill > 0:
                d.rounded_rectangle((sx0, y0, sx0 + max(12, seg * fill), y1), radius=6, fill=self.colors["orange"] + (255,))

    def _compose(self, scene_index: int, t: float, entry: float, bg_from: Optional[int]):
        from PIL import Image

        scene = self.scenes[scene_index]
        frame = self._background(scene_index, t)
        if bg_from is not None and entry < 1:
            previous = self._background(bg_from, self.scenes[bg_from]["end"])
            frame = Image.blend(previous, frame, ease_in_out(entry))
        card = self._card_image(scene_index, t)
        x0, y0 = self.layouts[scene_index]["card"][:2]
        span = max(1e-6, scene["end"] - scene["start"])
        drift = int(round(-10 * ((t - scene["start"]) / span)))  # micro-parallax against the background
        transition = scene["transition"]
        if transition == "slide" and entry < 1:
            frame.alpha_composite(self._fade(card, entry), (int(x0 + 420 * (1 - entry)), y0 + drift))
        elif transition == "scale" and entry < 1:
            scale = 0.88 + 0.12 * entry
            w, h = int(card.width * scale), int(card.height * scale)
            scaled = card.resize((w, h), Image.BILINEAR)
            frame.alpha_composite(self._fade(scaled, entry), (x0 + (card.width - w) // 2, y0 + drift + (card.height - h) // 2))
        else:
            frame.alpha_composite(card, (x0, y0 + drift))
        frame.alpha_composite(self.chrome)
        self._progress(frame, t)
        return frame

    def settled_end_frame(self, scene_index: int):
        if scene_index not in self._settled_cache:
            scene = self.scenes[scene_index]
            self._settled_cache = {scene_index: self._compose(scene_index, scene["end"] - 1 / FPS, 1.0, None)}
        return self._settled_cache[scene_index]

    def frame(self, frame_index: int):
        from PIL import Image, ImageDraw

        t = frame_index / FPS
        index = self.scene_at(frame_index)
        scene = self.scenes[index]
        entry = 1.0 if index == 0 else ease_out_cubic((t - scene["start"]) / TRANSITION_SECONDS)
        if scene["transition"] == "wipe" and entry < 1:
            new = self._compose(index, t, 1.0, None)
            old = self.settled_end_frame(index - 1)
            edge = int(WIDTH * entry)
            mask = Image.new("L", (WIDTH, HEIGHT), 0)
            ImageDraw.Draw(mask).rectangle((0, 0, edge, HEIGHT), fill=255)
            frame = Image.composite(new, old, mask)
            ImageDraw.Draw(frame).rectangle((edge - 9, 0, edge + 9, HEIGHT), fill=self.colors["orange"] + (255,))
            self._progress(frame, t)
            return frame.convert("RGB")
        return self._compose(index, t, entry, index - 1 if index else None).convert("RGB")

    def frames(self) -> Iterator[bytes]:
        for index in range(self.plan["total_frames"]):
            yield self.frame(index).convert("RGBA").tobytes("raw", "BGRA")


# --- Frame QA and contact sheet --------------------------------------------------------


def frame_stats(image) -> Dict[str, float]:
    from PIL import ImageStat

    gray = image.convert("L")
    stat = ImageStat.Stat(gray)
    small = image.convert("RGB").resize((108, 192))
    return {"mean": stat.mean[0], "stddev": stat.stddev[0], "colors": len(set(small.getdata()))}


def assert_not_empty(image, label: str) -> Dict[str, float]:
    stats = frame_stats(image)
    if stats["stddev"] < 12 or stats["colors"] < 200 or stats["mean"] < 8:
        raise MotionError(f"Frame {label} looks empty: {stats}")
    return stats


def contact_moments(plan: Dict[str, Any]) -> List[Tuple[int, str]]:
    """At least 8 moments: hook landing, every scene settled, and two transitions."""
    scenes = plan["scenes"]
    moments = [(0, "hook start"), (min(frames_for(HOOK_DEADLINE_SECONDS) - 1, scenes[0]["end_frame"] - 1), "hook landed")]
    for scene in scenes[1:]:
        settled = min(scene["end_frame"] - 1, scene["start_frame"] + frames_for(1.2))
        moments.append((settled, f"{scene['kind']}{' ' + str(scene['tip_number']) if scene.get('tip_number') else ''}"))
    for scene in scenes[1:3]:
        moments.append((scene["start_frame"] + frames_for(TRANSITION_SECONDS / 2), f"{scene['transition']} transition"))
    moments.append((plan["total_frames"] - 1, "last frame"))
    unique: Dict[int, str] = {}
    for frame_index, label in moments:
        unique.setdefault(frame_index, label)
    return sorted(unique.items())


def contact_sheet(renderer: Renderer, path: Path, columns: int = 4) -> Dict[str, Any]:
    from PIL import Image, ImageDraw

    moments = contact_moments(renderer.plan)
    if len(moments) < 8:
        raise MotionError("Contact sheet needs at least 8 moments")
    thumb_w, thumb_h, label_h, gap = 270, 480, 44, 12
    rows = math.ceil(len(moments) / columns)
    sheet = Image.new("RGB", (columns * thumb_w + (columns + 1) * gap, rows * (thumb_h + label_h) + (rows + 1) * gap), renderer.colors["ink"])
    d = ImageDraw.Draw(sheet)
    font = renderer.fonts.get("label", 22)
    stats = []
    for i, (frame_index, label) in enumerate(moments):
        image = renderer.frame(frame_index)
        stats.append({"frame": frame_index, "label": label, **assert_not_empty(image, label)})
        x = gap + (i % columns) * (thumb_w + gap)
        y = gap + (i // columns) * (thumb_h + label_h + gap)
        sheet.paste(image.resize((thumb_w, thumb_h), Image.LANCZOS), (x, y))
        d.text((x + 4, y + thumb_h + 8), f"{frame_index / FPS:5.2f}s · {label}", font=font, fill=renderer.colors["paper"])
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, format="PNG", optimize=True)
    return {"path": str(path), "moments": stats, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
