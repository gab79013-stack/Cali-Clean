#!/usr/bin/env python3
"""Fail-closed private video draft generator for Cali Clean."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
BRAND_PATH = ROOT / "config" / "brand.json"
TOPICS_PATH = ROOT / "config" / "topics.json"
RUNTIME_PATH = ROOT / "config" / "runtime.json"
DISCLOSURE_EN = "Illustrative AI-generated visual — not client work or company personnel."
DISCLOSURE_ES = "Imagen ilustrativa generada con IA; no representa clientes ni personal."


class PolicyError(RuntimeError):
    pass


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def write_private(path: Path, data: str) -> None:
    private_dir(path.parent)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(data, encoding="utf-8")
    temp.chmod(0o600)
    os.replace(temp, path)
    path.chmod(0o600)


def write_json_private(path: Path, value: Dict[str, Any]) -> None:
    write_private(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def validate_brand(brand: Dict[str, Any], root: Path = ROOT) -> None:
    if brand.get("website") != "https://cali-clean.net/":
        raise PolicyError("The only allowed CTA website is https://cali-clean.net/")
    colors = brand.get("colors", {})
    if not colors or any(not re.fullmatch(r"#[0-9a-fA-F]{6}", value) for value in colors.values()):
        raise PolicyError("Brand colors are missing or malformed")
    required_sources = {"https://cali-clean.net/", "https://cali-clean.net/es/"}
    if not required_sources.issubset(set(brand.get("official_sources", []))):
        raise PolicyError("Official English and Spanish sources are required")
    font = brand.get("font", {})
    asset_records = list(brand.get("assets", [])) + ([font] if font else [])
    for asset in asset_records:
        path_value = asset.get("path") or asset.get("asset")
        expected = asset.get("sha256")
        if not path_value or not expected:
            raise PolicyError("Every brand asset must have a pinned path and hash")
        path = root / path_value
        if not path.is_file() or sha256_file(path) != expected:
            raise PolicyError(f"Brand asset integrity failure: {path_value}")


def validate_copy(texts: Iterable[str], brand: Dict[str, Any]) -> None:
    combined = "\n".join(texts)
    lowered = combined.casefold()
    for fragment in brand["content_rules"]["forbidden_claim_fragments"]:
        if fragment.casefold() in lowered:
            raise PolicyError(f"Unsupported claim fragment: {fragment}")
    if re.search(r"\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b", combined):
        raise PolicyError("Phone numbers are not allowed in generated draft copy")
    if re.search(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", combined):
        raise PolicyError("Email addresses are not allowed in generated draft copy")
    if re.search(r"(?:\$|USD\b|dollars?\b|dólares?\b)\s*\d", combined, re.I):
        raise PolicyError("Prices are not allowed in generated draft copy")


def parse_slot(value: str | None, timezone: str) -> datetime:
    zone = ZoneInfo(timezone)
    if value:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=zone)
        return parsed.astimezone(zone).replace(minute=0, second=0, microsecond=0)
    return datetime.now(zone).replace(minute=0, second=0, microsecond=0)


@dataclass(frozen=True)
class Plan:
    slot: datetime
    language: str
    angle: str
    topic: Dict[str, Any]
    draft_id: str


def choose_plan(slot: datetime, brand: Dict[str, Any], topics: Dict[str, Any]) -> Plan:
    hour_index = int(slot.timestamp() // 3600)
    topic_items = topics["topics"]
    topic = topic_items[hour_index % len(topic_items)]
    language_cycle = topics["language_cycle"]
    language = language_cycle[hour_index % len(language_cycle)]
    angles = topics["angles"]
    angle = angles[(hour_index // len(topic_items)) % len(angles)]
    raw = "|".join([
        slot.isoformat(), topic["id"], language, angle,
        brand["brand_version"], topics["template_version"],
    ])
    draft_id = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
    return Plan(slot=slot, language=language, angle=angle, topic=topic, draft_id=draft_id)


def build_storyboard(plan: Plan, brand: Dict[str, Any], runtime: Dict[str, Any]) -> Dict[str, Any]:
    lang = plan.language
    disclosure = brand["content_rules"]["required_visual_disclosure"][lang]
    coverage_short = (
        "San Diego homes, workplaces and properties."
        if lang == "en"
        else "Hogares, negocios y propiedades de San Diego."
    )
    process = (
        "Tell us about the space. Choose priorities. Confirm the details."
        if lang == "en"
        else "Cuéntenos del espacio. Elija prioridades. Confirme los detalles."
    )
    middle = {
        "service": plan.topic["body"][lang],
        "process": process,
        "coverage": coverage_short,
    }[plan.angle]
    scenes = [
        {"start": 0.0, "end": 3.5, "eyebrow": brand["location"].upper(), "headline": plan.topic["hook"][lang], "body": plan.topic["title"][lang]},
        {"start": 3.5, "end": 7.5, "eyebrow": plan.topic["title"][lang].upper(), "headline": middle, "body": brand["taglines"][lang]},
        {"start": 7.5, "end": 11.5, "eyebrow": "CALI CLEAN", "headline": brand["hero"][lang], "body": coverage_short},
        {"start": 11.5, "end": float(runtime["output"]["duration_seconds"]), "eyebrow": plan.topic["title"][lang].upper(), "headline": brand["cta"][lang], "body": disclosure},
    ]
    validate_copy([scene[key] for scene in scenes for key in ("eyebrow", "headline", "body")], brand)
    return {
        "schema": "caliclean.video-draft/v1",
        "draft_id": plan.draft_id,
        "slot": plan.slot.isoformat(),
        "status": "dry_run",
        "language": lang,
        "angle": plan.angle,
        "topic_id": plan.topic["id"],
        "asset_id": plan.topic["asset"],
        "brand_version": brand["brand_version"],
        "output": runtime["output"],
        "publication": {
            "enabled": False,
            "destinations": [],
            "meta_connected": False,
        },
        "review": {"required": True, "decision": None},
        "scenes": scenes,
        "safety": {
            "official_assets_only": True,
            "personal_data": False,
            "testimonials": False,
            "ratings": False,
            "before_after": False,
            "discounts": False,
            "certifications": False,
            "prices": False,
            "outreach": False,
        },
    }


def manifest_markdown(manifest: Dict[str, Any]) -> str:
    lines = [
        f"# Cali Clean draft {manifest['draft_id']}",
        "",
        f"- Status: `{manifest['status']}`",
        f"- Slot: `{manifest['slot']}`",
        f"- Language: `{manifest['language']}`",
        f"- Topic: `{manifest['topic_id']}`",
        f"- Publication: **disabled**",
        "",
        "## Storyboard",
        "",
    ]
    for index, scene in enumerate(manifest["scenes"], 1):
        lines.extend([
            f"### Scene {index} · {scene['start']:.1f}–{scene['end']:.1f}s",
            "",
            f"**{scene['headline']}**",
            "",
            scene["body"],
            "",
        ])
    return "\n".join(lines)


def ensure_runtime_safe(runtime: Dict[str, Any]) -> None:
    if runtime.get("publication_enabled"):
        raise PolicyError("Publication must remain disabled")
    if runtime.get("meta_connected"):
        raise PolicyError("Meta must remain disconnected")
    if runtime["output"].get("audio"):
        raise PolicyError("Pilot audio must remain disabled")


def output_paths(runtime: Dict[str, Any], draft_id: str) -> Dict[str, Path]:
    review = ROOT / runtime["storage"]["review"]
    drafts = ROOT / runtime["storage"]["drafts"] / draft_id
    return {
        "review": review,
        "manifest": review / f"{draft_id}.json",
        "storyboard": review / f"{draft_id}.md",
        "draft_dir": drafts,
        "video": drafts / f"{draft_id}.mp4",
    }


def persist_manifest(manifest: Dict[str, Any], runtime: Dict[str, Any]) -> Dict[str, Path]:
    paths = output_paths(runtime, manifest["draft_id"])
    private_dir(paths["review"])
    write_json_private(paths["manifest"], manifest)
    write_private(paths["storyboard"], manifest_markdown(manifest))
    return paths


def enforce_render_quota(runtime: Dict[str, Any], slot: datetime) -> None:
    review = ROOT / runtime["storage"]["review"]
    limit = int(runtime["limits"]["max_real_renders_per_day"])
    count = 0
    if review.exists():
        for path in review.glob("*.json"):
            try:
                payload = load_json(path)
            except Exception:
                continue
            if payload.get("status") != "qa_pending":
                continue
            try:
                stamp = datetime.fromisoformat(payload["slot"]).astimezone(slot.tzinfo)
            except Exception:
                continue
            if stamp.date() == slot.date():
                count += 1
    if count >= limit:
        raise PolicyError(f"Daily pilot-render quota reached ({count}/{limit})")


def _fonts():
    from PIL import ImageFont

    font_path = ROOT / "assets" / "manrope.woff2"
    return {
        "eyebrow": ImageFont.truetype(str(font_path), 34),
        "headline": ImageFont.truetype(str(font_path), 92),
        "body": ImageFont.truetype(str(font_path), 46),
        "small": ImageFont.truetype(str(font_path), 25),
        "brand": ImageFont.truetype(str(font_path), 54),
    }


def _hex(value: str):
    from PIL import ImageColor

    return ImageColor.getrgb(value)


def _fit_crop(image, size):
    from PIL import ImageOps

    return ImageOps.fit(image, size, method=3, centering=(0.5, 0.5))


def _wrap(draw, text: str, font, max_width: int, max_lines: int) -> List[str]:
    words = text.split()
    lines: List[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
        if len(lines) == max_lines:
            raise PolicyError("Copy exceeds the maximum number of readable lines")
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        raise PolicyError("Copy exceeds the maximum number of readable lines")
    return lines


def render_cards(manifest: Dict[str, Any], brand: Dict[str, Any], runtime: Dict[str, Any], target: Path) -> List[Path]:
    from PIL import Image, ImageDraw

    private_dir(target)
    width = int(runtime["output"]["width"])
    height = int(runtime["output"]["height"])
    fonts = _fonts()
    asset = next(item for item in brand["assets"] if item["id"] == manifest["asset_id"])
    source = Image.open(ROOT / asset["path"]).convert("RGB")
    background = _fit_crop(source, (width, height))
    colors = {key: _hex(value) for key, value in brand["colors"].items()}
    cards: List[Path] = []
    for index, scene in enumerate(manifest["scenes"], 1):
        image = background.copy().convert("RGBA")
        overlay = Image.new("RGBA", image.size, colors["teal"] + (178 if index < 4 else 215,))
        image = Image.alpha_composite(image, overlay)
        draw = ImageDraw.Draw(image)
        safe_x = 94
        safe_w = width - safe_x * 2
        draw.rounded_rectangle((safe_x, 110, width - safe_x, 175), radius=28, fill=colors["sage"] + (235,))
        draw.text((safe_x + 28, 126), scene["eyebrow"], font=fonts["eyebrow"], fill=colors["ink"])
        y = 445
        for line in _wrap(draw, scene["headline"], fonts["headline"], safe_w, 5):
            draw.text((safe_x, y), line, font=fonts["headline"], fill=colors["paper"], stroke_width=1)
            y += 112
        y += 34
        for line in _wrap(draw, scene["body"], fonts["body"], safe_w, 5):
            draw.text((safe_x, y), line, font=fonts["body"], fill=colors["sage"])
            y += 65
        draw.line((safe_x, height - 330, width - safe_x, height - 330), fill=colors["orange"], width=8)
        draw.text((safe_x, height - 278), "cali", font=fonts["brand"], fill=colors["paper"])
        cali_w = draw.textbbox((safe_x, 0), "cali", font=fonts["brand"])[2] - safe_x
        draw.text((safe_x + cali_w, height - 278), "clean", font=fonts["brand"], fill=colors["sage"])
        disclosure = brand["content_rules"]["required_visual_disclosure"][manifest["language"]]
        for line_number, line in enumerate(_wrap(draw, disclosure, fonts["small"], safe_w, 3)):
            draw.text((safe_x, height - 174 + line_number * 34), line, font=fonts["small"], fill=colors["paper"])
        path = target / f"scene-{index:02d}.png"
        image.convert("RGB").save(path, format="PNG", optimize=True)
        path.chmod(0o600)
        cards.append(path)
    return cards


def render_video(manifest: Dict[str, Any], brand: Dict[str, Any], runtime: Dict[str, Any], paths: Dict[str, Path]) -> Dict[str, Any]:
    if shutil.which("swift") is None and not Path("/usr/bin/swift").exists():
        raise PolicyError("macOS Swift/AVFoundation renderer is unavailable")
    build_dir = ROOT / ".build"
    private_dir(build_dir)
    binaries = {
        "render": (ROOT / "src" / "render_mp4.swift", build_dir / "render_mp4"),
        "inspect": (ROOT / "src" / "inspect_mp4.swift", build_dir / "inspect_mp4"),
    }
    for source, binary in binaries.values():
        if not binary.exists() or binary.stat().st_mtime < source.stat().st_mtime:
            temp = binary.with_suffix(".tmp")
            subprocess.run(
                ["/usr/bin/swiftc", str(source), "-o", str(temp)],
                check=True, capture_output=True, text=True, timeout=240,
            )
            os.replace(temp, binary)
            binary.chmod(0o700)
    enforce_render_quota(runtime, datetime.fromisoformat(manifest["slot"]))
    cards = render_cards(manifest, brand, runtime, paths["draft_dir"])
    output = runtime["output"]
    command = [
        str(binaries["render"][1]), str(paths["video"]),
        str(output["width"]), str(output["height"]), str(output["fps"]), str(output["duration_seconds"]),
        *[str(path) for path in cards],
    ]
    completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=240)
    paths["video"].chmod(0o600)
    inspected = subprocess.run(
        [str(binaries["inspect"][1]), str(paths["video"])],
        check=True, capture_output=True, text=True, timeout=120,
    )
    metadata = json.loads(inspected.stdout.strip())
    if round(metadata["width"]) != output["width"] or round(metadata["height"]) != output["height"]:
        raise PolicyError(f"Rendered dimensions do not match 9:16 target: {metadata}")
    if abs(float(metadata["duration"]) - float(output["duration_seconds"])) > 0.2:
        raise PolicyError(f"Rendered duration does not match target: {metadata}")
    if metadata["codec_fourcc"] not in {"avc1", "h264"}:
        raise PolicyError(f"Unexpected video codec: {metadata['codec_fourcc']}")
    return {
        "engine": "macOS AVFoundation",
        "provider_cost": 0,
        "video": str(paths["video"]),
        "sha256": sha256_file(paths["video"]),
        "bytes": paths["video"].stat().st_size,
        "metadata": metadata,
        "renderer_output": completed.stdout.strip(),
    }


def prune(runtime: Dict[str, Any], now: datetime) -> Dict[str, int]:
    counts = {"drafts": 0, "review": 0}
    cutoffs = {
        "drafts": now - timedelta(days=int(runtime["retention"]["draft_days"])),
        "review": now - timedelta(days=int(runtime["retention"]["manifest_days"])),
    }
    for key in ("drafts", "review"):
        root = ROOT / runtime["storage"][key]
        if not root.exists():
            continue
        for path in root.iterdir():
            if path.name == ".gitkeep":
                continue
            modified = datetime.fromtimestamp(path.stat().st_mtime, tz=now.tzinfo)
            if modified < cutoffs[key]:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
                counts[key] += 1
    return counts


def run(command: str, slot_value: str | None) -> Dict[str, Any]:
    brand = load_json(BRAND_PATH)
    topics = load_json(TOPICS_PATH)
    runtime = load_json(RUNTIME_PATH)
    validate_brand(brand)
    ensure_runtime_safe(runtime)
    slot = parse_slot(slot_value, runtime["timezone"])

    if command == "hourly":
        if not runtime.get("routine_enabled"):
            raise PolicyError("Hourly routine is disabled in config/runtime.json")
        prune(runtime, slot)
        if not runtime.get("render_enabled"):
            raise PolicyError("Hourly rendering is disabled in config/runtime.json")

    plan = choose_plan(slot, brand, topics)
    manifest = build_storyboard(plan, brand, runtime)
    paths = output_paths(runtime, manifest["draft_id"])

    if paths["manifest"].exists():
        existing = load_json(paths["manifest"])
        return {"status": "idempotent_existing", "manifest": str(paths["manifest"]), "draft": existing}

    if command == "render-pilot":
        rendering = render_video(manifest, brand, runtime, paths)
        manifest["status"] = "qa_pending"
        manifest["render"] = rendering
    elif command == "hourly":
        rendering = render_video(manifest, brand, runtime, paths)
        manifest["status"] = "qa_pending"
        manifest["render"] = rendering

    persist_manifest(manifest, runtime)
    return {
        "status": manifest["status"],
        "draft_id": manifest["draft_id"],
        "manifest": str(paths["manifest"]),
        "storyboard": str(paths["storyboard"]),
        "video": str(paths["video"]) if paths["video"].exists() else None,
        "publication_enabled": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("dry-run", "render-pilot", "hourly"))
    parser.add_argument("--slot", help="ISO timestamp; rounded down to the hour")
    args = parser.parse_args()
    try:
        result = run(args.command, args.slot)
    except (PolicyError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
