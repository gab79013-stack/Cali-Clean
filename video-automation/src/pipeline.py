#!/usr/bin/env python3
"""Fail-closed private video draft generator for Cali Clean."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence
from zoneinfo import ZoneInfo

SRC_DIR = Path(__file__).resolve().parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from meta_adapter import DisabledMetaAdapter  # noqa: E402  (offline, no network imports)
import motion  # noqa: E402  (offline motion generator; Pillow is imported lazily)

ROOT = SRC_DIR.parent
# Read-only, hash-pinned brand assets always come from the project tree.
ASSET_ROOT = SRC_DIR.parent
BRAND_PATH = ROOT / "config" / "brand.json"
TOPICS_PATH = ROOT / "config" / "topics.json"
RUNTIME_PATH = ROOT / "config" / "runtime.json"
DISCLOSURE_EN = "Illustrative AI-generated visual — not client work or company personnel."
DISCLOSURE_ES = "Imagen ilustrativa generada con IA; no representa clientes ni personal."

# Output contract for reviewable Reels-style drafts.
OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
MIN_DURATION_SECONDS = 18.0
MAX_DURATION_SECONDS = 24.0
DURATION_TOLERANCE_SECONDS = 0.2
ALLOWED_CODECS = {"avc1", "h264"}
LOCAL_RENDERER = "local_avfoundation"

# Toolchain. xcrun resolves swiftc and the SDK selected by xcode-select, so the
# compiler always matches the SDK instead of whatever /usr/bin/swiftc points at.
XCRUN = "/usr/bin/xcrun"
XCODE_SELECT = "/usr/bin/xcode-select"
MACOS_DEPLOYMENT_TARGET = "13.0"
SWIFT_LANGUAGE_VERSION = "5"
SUPPORTED_ARCHS = {"arm64", "x86_64"}
MIN_FREE_BYTES = 1 * 1024 * 1024 * 1024
OBJC_FRAMEWORKS = ("Foundation", "AVFoundation", "CoreMedia", "CoreVideo", "CoreGraphics", "ImageIO")
# Compiler output that means swiftc and the SDK disagree (not a bug in our code).
SWIFT_INCOMPATIBILITY_PATTERNS = (
    "redefinition of module",
    "swiftbridging",
    "could not build module",
    "failed to build module",
    "could not build objective-c module",
    "module compiled with swift",
    "compiled module was created by",
    "cannot load module",
    "cannot load underlying module",
    "unable to load standard library",
    "sdk is not supported by the compiler",
    "is not supported by this compiler",
    "missing required module",
    "no such module 'swift'",
)

KILL_ENV = "CALI_CLEAN_VIDEO_KILL"
KILL_FILE = "KILL"
LOCK_FILE = "pipeline.lock"
LEDGER_FILE = "render-ledger.jsonl"
MAX_QUOTA_OVERRIDES_PER_DAY = 1
MAX_OVERRIDE_REASON_CHARS = 500
TRUTHY = {"1", "true", "yes", "on"}
BACKEND_ENV = "CALI_CLEAN_RENDER_BACKEND"
VFS_ENV = "CALI_CLEAN_SWIFT_VFS"
OVERLAY_MODULES = {"SwiftBridging"}
# Only module maps shipped by Apple developer tools may be shadowed by the overlay.
APPLE_DEVELOPER_ROOTS = ("/Library/Developer/CommandLineTools/", "/Applications/")
RENDER_TIMEOUT_SECONDS = 900

Runner = Callable[..., subprocess.CompletedProcess]


class PolicyError(RuntimeError):
    pass


class ToolchainError(PolicyError):
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


def storage_path(runtime: Dict[str, Any], key: str) -> Path:
    """Resolve a configured storage directory and refuse anything outside var/."""
    base = (ROOT / "var").resolve()
    path = (ROOT / runtime["storage"][key]).resolve()
    if path != base and base not in path.parents:
        raise PolicyError(f"Storage path for {key!r} escapes var/: {path}")
    return path


def now_local(runtime: Dict[str, Any]) -> datetime:
    return datetime.now(ZoneInfo(runtime["timezone"]))


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
    script: Dict[str, Any]
    draft_id: str


def choose_plan(slot: datetime, brand: Dict[str, Any], topics: Dict[str, Any]) -> Plan:
    hour_index = int(slot.timestamp() // 3600)
    language_cycle = topics["language_cycle"]
    language = language_cycle[hour_index % len(language_cycle)]
    scripts = topics["scripts"]
    script = scripts[(hour_index // len(language_cycle)) % len(scripts)]
    raw = "|".join([
        slot.isoformat(), script["id"], language,
        brand["brand_version"], topics["template_version"],
    ])
    draft_id = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
    return Plan(slot=slot, language=language, script=script, draft_id=draft_id)


def build_storyboard(plan: Plan, brand: Dict[str, Any], runtime: Dict[str, Any], topics: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    topics = topics or load_json(TOPICS_PATH)
    try:
        motion_plan = motion.build_plan(plan.script, plan.language, brand, topics["labels"])
        motion.validate_plan(motion_plan)
    except motion.MotionError as exc:
        raise PolicyError(str(exc))
    validate_copy(
        [scene[key] for scene in motion_plan["scenes"] for key in ("eyebrow", "headline", "support")],
        brand,
    )
    return {
        "schema": "caliclean.video-draft/v2",
        "template_version": topics["template_version"],
        "draft_id": plan.draft_id,
        "slot": plan.slot.isoformat(),
        "status": "dry_run",
        "language": plan.language,
        "script_id": plan.script["id"],
        "service": plan.script["service"],
        "asset_id": motion_plan["asset_id"],
        "brand_version": brand["brand_version"],
        "output": {**runtime["output"], "duration_seconds": motion_plan["duration_seconds"], "frames": motion_plan["total_frames"]},
        "disclosure": motion_plan["disclosure"],
        "publication": {
            "enabled": False,
            "destinations": [],
            "meta_connected": False,
        },
        "review": {"required": True, "decision": None},
        "scenes": motion_plan["scenes"],
        "motion": {key: motion_plan[key] for key in ("fps", "width", "height", "total_frames", "duration_seconds", "cta_url")},
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
            "invented_results": False,
        },
    }


def validate_branding(manifest: Dict[str, Any], brand: Dict[str, Any]) -> None:
    """Every draft must close on the official CTA and carry the AI-visual disclosure."""
    lang = manifest["language"]
    scenes = manifest["scenes"]
    if not motion.MIN_SCENES <= len(scenes) <= motion.MAX_SCENES:
        raise PolicyError(f"Storyboard must have {motion.MIN_SCENES}-{motion.MAX_SCENES} scenes")
    final = scenes[-1]
    if final["kind"] != "cta" or brand["cta"][lang] not in final["headline"] or "cali-clean.net" not in final["headline"]:
        raise PolicyError("Final scene must carry the official cali-clean.net CTA")
    if manifest["disclosure"] != brand["content_rules"]["required_visual_disclosure"][lang]:
        raise PolicyError("Draft must carry the required visual disclosure")
    if scenes[0]["kind"] != "hook":
        raise PolicyError("Storyboard must open with a hook")
    if manifest["asset_id"] not in {asset["id"] for asset in brand["assets"]}:
        raise PolicyError(f"Unknown brand asset: {manifest['asset_id']}")
    previous_end = 0
    for scene in scenes:
        if scene["start_frame"] != previous_end or scene["end_frame"] <= scene["start_frame"]:
            raise PolicyError("Scenes must be contiguous and non-empty")
        previous_end = scene["end_frame"]
    if previous_end != manifest["output"]["frames"]:
        raise PolicyError("Storyboard must cover the full output duration")


def manifest_markdown(manifest: Dict[str, Any]) -> str:
    lines = [
        f"# Cali Clean draft {manifest['draft_id']}",
        "",
        f"- Status: `{manifest['status']}`",
        f"- Slot: `{manifest['slot']}`",
        f"- Language: `{manifest['language']}`",
        f"- Script: `{manifest['script_id']}` ({manifest['service']})",
        f"- Duration: {manifest['output']['duration_seconds']:.2f}s · {manifest['output']['frames']} frames @ {manifest['output']['fps']} fps",
        f"- Publication: **disabled**",
        "",
        "## Storyboard",
        "",
    ]
    for scene in manifest["scenes"]:
        reading = scene["reading"]
        lines.extend([
            f"### {scene['index'] + 1} · {scene['kind']} · {scene['start']:.2f}–{scene['end']:.2f}s · {scene['transition']}",
            "",
            f"`{scene['eyebrow']}`",
            "",
            f"**{scene['headline']}**",
            "",
            scene["support"],
            "",
            f"_Reading: needs {max(reading['need_headline'], reading['need_all']):.2f}s, has {reading['available']:.2f}s._",
            "",
        ])
    return "\n".join(lines)


def validate_output_spec(output: Dict[str, Any]) -> None:
    if int(output["width"]) != OUTPUT_WIDTH or int(output["height"]) != OUTPUT_HEIGHT:
        raise PolicyError(f"Output must be {OUTPUT_WIDTH}x{OUTPUT_HEIGHT}")
    if int(output["fps"]) != motion.FPS:
        raise PolicyError(f"Output must be {motion.FPS} fps")
    low, high = float(output["min_duration_seconds"]), float(output["max_duration_seconds"])
    if (low, high) != (MIN_DURATION_SECONDS, MAX_DURATION_SECONDS):
        raise PolicyError(f"Output duration window must be {MIN_DURATION_SECONDS:g}–{MAX_DURATION_SECONDS:g} s")
    if output.get("format") != "mp4" or output.get("codec") != "h264":
        raise PolicyError("Output must be H.264 MP4")
    if output.get("audio"):
        raise PolicyError("Pilot audio must remain disabled")


def ensure_zero_cost(runtime: Dict[str, Any]) -> None:
    renderers = runtime.get("renderers", {})
    if renderers.get("active") != LOCAL_RENDERER:
        raise PolicyError(f"Only the {LOCAL_RENDERER} renderer is allowed")
    local = renderers.get(LOCAL_RENDERER, {})
    if local.get("per_render_provider_cost") != 0:
        raise PolicyError("The local renderer must have zero provider cost")
    for name, settings in renderers.items():
        if name in {"active", LOCAL_RENDERER} or not isinstance(settings, dict):
            continue
        if settings.get("enabled"):
            raise PolicyError(f"Paid provider {name!r} must remain disabled")


def ensure_runtime_safe(runtime: Dict[str, Any]) -> None:
    if runtime.get("publication_enabled"):
        raise PolicyError("Publication must remain disabled")
    if runtime.get("meta_connected"):
        raise PolicyError("Meta must remain disconnected")
    validate_output_spec(runtime["output"])
    ensure_zero_cost(runtime)


# --- Kill switch, lock, quota ledger ---------------------------------------------------


def kill_switch_reason(runtime: Dict[str, Any], env: Optional[Dict[str, str]] = None) -> Optional[str]:
    env = os.environ if env is None else env
    if env.get(KILL_ENV, "").strip().lower() in TRUTHY:
        return f"environment variable {KILL_ENV}"
    if (storage_path(runtime, "state") / KILL_FILE).exists():
        return f"kill file {runtime['storage']['state']}/{KILL_FILE}"
    return None


def ensure_not_killed(runtime: Dict[str, Any], env: Optional[Dict[str, str]] = None) -> None:
    reason = kill_switch_reason(runtime, env)
    if reason:
        raise PolicyError(f"Kill switch engaged ({reason}); refusing to render")


@contextmanager
def exclusive_lock(runtime: Dict[str, Any]) -> Iterator[Path]:
    path = storage_path(runtime, "state") / LOCK_FILE
    private_dir(path.parent)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise PolicyError("Another pipeline run holds the lock; refusing to run concurrently")
    try:
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
        yield path
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def lock_is_free(runtime: Dict[str, Any]) -> bool:
    try:
        with exclusive_lock(runtime):
            return True
    except PolicyError:
        return False


def read_ledger(runtime: Dict[str, Any]) -> List[Dict[str, Any]]:
    path = storage_path(runtime, "state") / LEDGER_FILE
    if not path.exists():
        return []
    entries = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            raise PolicyError(f"Render ledger line {number} is corrupt; refusing to guess the quota")
    return entries


def append_ledger(runtime: Dict[str, Any], record: Dict[str, Any]) -> None:
    path = storage_path(runtime, "state") / LEDGER_FILE
    private_dir(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    path.chmod(0o600)


def quota_usage(runtime: Dict[str, Any], now: datetime) -> Dict[str, int]:
    """Count today's renders by wall-clock time, never by the requested slot."""
    zone = ZoneInfo(runtime["timezone"])
    today = now.astimezone(zone).date()
    attempts = completed = 0
    for entry in read_ledger(runtime):
        try:
            stamp = datetime.fromisoformat(entry["at"]).astimezone(zone)
        except (KeyError, ValueError):
            raise PolicyError("Render ledger entry without a valid timestamp")
        if stamp.date() != today:
            continue
        if entry.get("event") == "started":
            attempts += 1
        elif entry.get("event") == "completed":
            completed += 1
    # Manifests are a second source of truth in case the ledger was removed.
    review = storage_path(runtime, "review")
    if review.exists():
        rendered = 0
        for path in review.glob("*.json"):
            try:
                payload = load_json(path)
                stamp = datetime.fromisoformat(payload["render"]["rendered_at"]).astimezone(zone)
            except Exception:
                continue
            if stamp.date() == today:
                rendered += 1
        completed = max(completed, rendered)
        attempts = max(attempts, completed)
    return {"attempts": attempts, "completed": completed}


def overrides_used_today(runtime: Dict[str, Any], now: datetime) -> int:
    zone = ZoneInfo(runtime["timezone"])
    today = now.astimezone(zone).date()
    return sum(
        1 for entry in read_ledger(runtime)
        if entry.get("event") == "quota_override"
        and datetime.fromisoformat(entry["at"]).astimezone(zone).date() == today
    )


def validate_override_reason(reason: Optional[str]) -> Optional[str]:
    if reason is None:
        return None
    cleaned = " ".join(reason.split())
    if not cleaned:
        raise PolicyError("--quota-override-reason must be a non-empty explanation")
    if len(cleaned) > MAX_OVERRIDE_REASON_CHARS:
        raise PolicyError(f"--quota-override-reason must be at most {MAX_OVERRIDE_REASON_CHARS} characters")
    return cleaned


def quota_status(runtime: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    usage = quota_usage(runtime, now)
    limits = runtime["limits"]
    max_renders = int(limits["max_real_renders_per_day"])
    max_attempts = int(limits.get("max_render_attempts_per_day", max_renders))
    used = overrides_used_today(runtime, now)
    exhausted = None
    if usage["completed"] >= max_renders:
        exhausted = f"Daily pilot-render quota reached ({usage['completed']}/{max_renders})"
    elif usage["attempts"] >= max_attempts:
        exhausted = f"Daily render-attempt quota reached ({usage['attempts']}/{max_attempts})"
    return {
        **usage,
        "max_renders": max_renders,
        "max_attempts": max_attempts,
        "overrides_used": used,
        "max_overrides": MAX_QUOTA_OVERRIDES_PER_DAY,
        "exhausted": exhausted,
        "override_available": exhausted is not None and used < MAX_QUOTA_OVERRIDES_PER_DAY,
    }


def enforce_render_quota(runtime: Dict[str, Any], now: datetime, override_reason: Optional[str] = None) -> Dict[str, Any]:
    """Normal quota first. A supervised override grants one extra attempt per day, only once the normal quota is spent."""
    status = quota_status(runtime, now)
    if status["exhausted"] is None:
        if override_reason is not None:
            raise PolicyError("Quota override refused: the normal daily quota is not exhausted; run without --quota-override-reason")
        return {**status, "override": False}
    if override_reason is None:
        raise PolicyError(status["exhausted"])
    if not status["override_available"]:
        raise PolicyError(
            f"{status['exhausted']}; the daily quota override was already used "
            f"({status['overrides_used']}/{MAX_QUOTA_OVERRIDES_PER_DAY})"
        )
    return {**status, "override": True}


def prune(runtime: Dict[str, Any], now: datetime, dry_run: bool = False) -> Dict[str, int]:
    retention = runtime["retention"]
    days = {
        "drafts": int(retention["draft_days"]),
        "review": int(retention["manifest_days"]),
        "logs": int(retention.get("log_days", retention["manifest_days"])),
    }
    counts = {key: 0 for key in days}
    for key, keep_days in days.items():
        if key not in runtime["storage"]:
            continue
        root = storage_path(runtime, key)
        if not root.exists():
            continue
        cutoff = now - timedelta(days=keep_days)
        for path in root.iterdir():
            if path.name == ".gitkeep" or path.is_symlink():
                continue
            if key == "review" and path.suffix not in {".json", ".md"}:
                continue
            modified = datetime.fromtimestamp(path.stat().st_mtime, tz=now.tzinfo)
            if modified >= cutoff:
                continue
            counts[key] += 1
            if dry_run:
                continue
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    return counts


# --- Toolchain --------------------------------------------------------------------------


@dataclass(frozen=True)
class Toolchain:
    xcrun: str
    swiftc: str
    sdk_path: str
    sdk_version: str
    target: str
    swiftc_version: str
    clang: str = ""
    clang_version: str = ""

    @property
    def arch(self) -> str:
        return self.target.split("-", 1)[0]

    def fingerprint(self) -> str:
        raw = "|".join([
            self.swiftc, self.swiftc_version, self.clang, self.clang_version,
            self.sdk_path, self.sdk_version, self.target, SWIFT_LANGUAGE_VERSION,
        ])
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CompileError(ToolchainError):
    """A compiler ran and failed; carries the complete output for classification."""

    def __init__(self, message: str, output: str, log_path: Path) -> None:
        super().__init__(message)
        self.output = output
        self.log_path = log_path


def run_diag(command: List[str], timeout: int, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    # stdin is closed so nothing can block waiting for a password or a prompt.
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)


def _human_required(stderr: str) -> Optional[str]:
    lowered = stderr.casefold()
    if "license" in lowered:
        return "the Xcode license has not been accepted (a human must run `sudo xcodebuild -license`)"
    if "no developer tools" in lowered or "xcode-select --install" in lowered or "invalid active developer path" in lowered:
        return "Command Line Tools are missing (a human must run `xcode-select --install`)"
    if "password" in lowered or "authoriz" in lowered:
        return "the system asked for authorization"
    return None


def resolve_toolchain(
    platform_name: str = sys.platform,
    machine: Optional[str] = None,
    runner: Runner = run_diag,
    exists: Callable[[str], bool] = os.path.exists,
) -> Toolchain:
    """Resolve swiftc (preferred) and clang (fallback) for the same xcrun-selected SDK.

    A missing or broken swiftc is tolerated as long as clang is usable; anything
    that needs a human (license, missing Command Line Tools, authorization) stops.
    """
    if platform_name != "darwin":
        raise ToolchainError(f"Local AVFoundation rendering requires macOS (darwin); this host is {platform_name!r}")
    for tool in (XCODE_SELECT, XCRUN):
        if not exists(tool):
            raise ToolchainError(f"Required tool is missing: {tool}")
    arch = machine or platform.machine()
    if arch not in SUPPORTED_ARCHS:
        raise ToolchainError(f"Unsupported CPU architecture: {arch!r}")

    def query(args: List[str], what: str, required: bool = True) -> str:
        result = runner(args, 60)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            human = _human_required(detail)
            if human:
                raise ToolchainError(f"Blocked: {human}. Command: {' '.join(args)}\n{detail}")
            if not required:
                return ""
            raise ToolchainError(f"Cannot resolve {what} (exit {result.returncode}): {' '.join(args)}\n{detail}")
        return result.stdout.strip()

    query([XCODE_SELECT, "-p"], "active developer directory")
    sdk_path = query([XCRUN, "--sdk", "macosx", "--show-sdk-path"], "macOS SDK path")
    sdk_version = query([XCRUN, "--sdk", "macosx", "--show-sdk-version"], "macOS SDK version")
    if not sdk_path or not os.path.isdir(sdk_path):
        raise ToolchainError(f"xcrun returned an SDK path that does not exist: {sdk_path!r}")

    swiftc = query([XCRUN, "--sdk", "macosx", "--find", "swiftc"], "swiftc", required=False)
    swiftc_version = ""
    if swiftc and exists(swiftc):
        swiftc_version = query([XCRUN, "--sdk", "macosx", "swiftc", "--version"], "swiftc version", required=False)
    else:
        swiftc = ""
    clang = query([XCRUN, "--sdk", "macosx", "--find", "clang"], "clang", required=False)
    clang_version = ""
    if clang and exists(clang):
        clang_version = query([XCRUN, "--sdk", "macosx", "clang", "--version"], "clang version", required=False)
    else:
        clang = ""
    if not swiftc and not clang:
        raise ToolchainError("Neither swiftc nor clang could be resolved through xcrun --sdk macosx")
    return Toolchain(
        xcrun=XCRUN,
        swiftc=swiftc,
        sdk_path=sdk_path,
        sdk_version=sdk_version,
        target=f"{arch}-apple-macos{MACOS_DEPLOYMENT_TARGET}",
        swiftc_version=swiftc_version.splitlines()[0] if swiftc_version else "",
        clang=clang,
        clang_version=clang_version.splitlines()[0] if clang_version else "",
    )


def swiftc_command(toolchain: Toolchain, source: Path, output: Path, module_cache: Path) -> List[str]:
    return [
        toolchain.xcrun, "--sdk", "macosx", "swiftc",
        "-sdk", toolchain.sdk_path,
        "-target", toolchain.target,
        "-swift-version", SWIFT_LANGUAGE_VERSION,
        "-module-cache-path", str(module_cache),
        "-O",
        str(source),
        "-o", str(output),
    ]


def clang_objc_command(toolchain: Toolchain, source: Path, output: Path, module_cache: Path) -> List[str]:
    # -fno-modules: headers are included textually, so no module map (and no
    # SwiftBridging module definition) from the SDK or Command Line Tools is read.
    command = [
        toolchain.xcrun, "--sdk", "macosx", "clang",
        "-x", "objective-c",
        "-fobjc-arc",
        "-fno-modules",
        "-isysroot", toolchain.sdk_path,
        "-arch", toolchain.arch,
        f"-mmacosx-version-min={MACOS_DEPLOYMENT_TARGET}",
        "-O2",
        "-Wall",
        "-Wno-deprecated-declarations",
        "-Werror=implicit-function-declaration",
        str(source),
        "-o", str(output),
    ]
    for framework in OBJC_FRAMEWORKS:
        command.extend(["-framework", framework])
    return command


def swift_env(module_cache: Path) -> Dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("SWIFT_", "CLANG_MODULE"))}
    env["CLANG_MODULE_CACHE_PATH"] = str(module_cache)
    return env


def diagnostic_log(command: List[str], result: subprocess.CompletedProcess, extra: Optional[Dict[str, Any]] = None) -> str:
    lines = [
        f"command: {' '.join(command)}",
        f"exit_code: {result.returncode}",
    ]
    for key, value in (extra or {}).items():
        lines.append(f"{key}: {value}")
    lines.extend(["", "--- stdout ---", result.stdout or "", "--- stderr ---", result.stderr or ""])
    return "\n".join(lines) + "\n"


def _compile(
    toolchain: Toolchain,
    name: str,
    source: Path,
    logs: List[Dict[str, Any]],
    log_dir: Path,
    runner: Runner,
    compiler: str,
    build_command: Callable[[Toolchain, Path, Path, Path], List[str]],
    salt: str = "",
) -> Path:
    build_dir = ROOT / ".build"
    private_dir(build_dir)
    binary = build_dir / name
    stamp = build_dir / f"{name}.stamp"
    expected = hashlib.sha256((sha256_file(source) + toolchain.fingerprint() + salt).encode()).hexdigest()
    if binary.exists() and stamp.exists() and stamp.read_text(encoding="utf-8").strip() == expected:
        return binary
    # A private module cache, wiped before every build, rules out stale or
    # unwritable shared caches (a common cause of "could not build module").
    module_cache = build_dir / "module-cache" / name
    if module_cache.exists():
        shutil.rmtree(module_cache)
    private_dir(module_cache)
    temp = build_dir / f"{name}.tmp"
    if temp.exists():
        temp.unlink()
    command = build_command(toolchain, source, temp, module_cache)
    result = runner(command, 300, swift_env(module_cache))
    log_path = log_dir / f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-build-{name}.log"
    write_private(log_path, diagnostic_log(command, result, {
        "compiler": compiler,
        "swiftc": f"{toolchain.swiftc} ({toolchain.swiftc_version})",
        "clang": f"{toolchain.clang} ({toolchain.clang_version})",
        "sdk": f"{toolchain.sdk_path} ({toolchain.sdk_version})",
        "target": toolchain.target,
        "module_cache": module_cache,
    }))
    logs.append({"step": f"build:{name}", "compiler": compiler, "exit_code": result.returncode, "log": str(log_path)})
    if result.returncode != 0 or not temp.exists():
        output = "\n".join(part for part in (result.stdout, result.stderr) if part)
        tail = "\n".join(output.strip().splitlines()[-25:])
        raise CompileError(
            f"{compiler} failed for {source.name} (exit {result.returncode}); full diagnostics: {log_path}\n{tail}",
            output, log_path,
        )
    os.replace(temp, binary)
    binary.chmod(0o700)
    write_private(stamp, expected + "\n")
    return binary


def compile_swift(
    toolchain: Toolchain,
    name: str,
    source: Path,
    logs: List[Dict[str, Any]],
    log_dir: Path,
    runner: Runner = run_diag,
    extra_flags: Sequence[str] = (),
    salt: str = "",
) -> Path:
    def command(tc: Toolchain, src: Path, out: Path, cache: Path) -> List[str]:
        base = swiftc_command(tc, src, out, cache)
        return base[:-3] + list(extra_flags) + base[-3:]

    return _compile(toolchain, name, source, logs, log_dir, runner, "swiftc", command, salt)


def compile_objc(toolchain: Toolchain, name: str, source: Path, logs: List[Dict[str, Any]], log_dir: Path, runner: Runner = run_diag) -> Path:
    return _compile(toolchain, name, source, logs, log_dir, runner, "clang", clang_objc_command)


def swift_incompatibility(output: str) -> Optional[str]:
    """Return the first line showing the Swift toolchain cannot use this SDK, if any.

    Only toolchain/SDK mismatches qualify; ordinary code errors never trigger the
    fallback, so a real bug in the Swift sources is never masked.
    """
    for line in output.splitlines():
        lowered = line.casefold()
        if any(pattern in lowered for pattern in SWIFT_INCOMPATIBILITY_PATTERNS):
            return line.strip()
    return None


_REDEFINITION = re.compile(r"(?P<path>/[^\s:]+\.modulemap):\d+:\d+: error: redefinition of module '(?P<module>[A-Za-z0-9_]+)'")
_PREVIOUSLY = re.compile(r"(?P<path>/[^\s:]+\.modulemap):\d+:\d+: note: previously defined here")


def requested_backend() -> str:
    value = (os.environ.get(BACKEND_ENV, "auto").strip().lower() or "auto")
    if value not in {"auto", "swift", "objc"}:
        raise PolicyError(f"{BACKEND_ENV} must be auto, swift or objc (got {value!r})")
    return value


def strip_module(text: str, module: str) -> str:
    """Remove every `module <name> { ... }` block (with nested braces) from a module map."""
    pattern = re.compile(r"(?:(?:explicit|framework|extern)\s+)*module\s+" + re.escape(module) + r"\b[^{]*\{")
    out = text
    while True:
        match = pattern.search(out)
        if not match:
            return out
        depth, index = 0, match.end() - 1
        while index < len(out):
            if out[index] == "{":
                depth += 1
            elif out[index] == "}":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        if depth != 0:
            raise ToolchainError(f"Unbalanced braces while removing module {module!r}")
        out = out[:match.start()] + out[index + 1:]


def swiftbridging_overlay(output: str, toolchain: Toolchain, build_dir: Path) -> Optional[Dict[str, Any]]:
    """Project-local, reversible fix for a duplicated module definition (e.g. SwiftBridging).

    Reads the redefinition diagnostics, copies each redefining module map into
    .build/vfs with the duplicate block removed, and returns a clang/swift VFS
    overlay that shadows the original. No system file is modified; deleting
    .build/vfs (or CALI_CLEAN_SWIFT_VFS=0) reverts it.
    """
    if os.environ.get(VFS_ENV, "1").strip().lower() in {"0", "false", "no", "off"}:
        return None
    redefinitions = list(dict.fromkeys(
        (match["path"], match["module"]) for match in _REDEFINITION.finditer(output) if match["module"] in OVERLAY_MODULES
    ))
    if not redefinitions:
        return None
    winners = {match["path"] for match in _PREVIOUSLY.finditer(output)}
    allowed = tuple(APPLE_DEVELOPER_ROOTS) + ((toolchain.sdk_path.rstrip("/") + "/",) if toolchain.sdk_path else ())
    vfs_dir = build_dir / "vfs"
    if vfs_dir.exists():
        shutil.rmtree(vfs_dir)
    private_dir(vfs_dir)
    roots: Dict[str, List[Dict[str, str]]] = {}
    hidden: List[Dict[str, str]] = []
    for path, module in redefinitions:
        if path in winners or not path.startswith(allowed) or not os.path.isfile(path):
            continue
        original = Path(path).read_text(encoding="utf-8", errors="replace")
        if not re.search(r"module\s+" + re.escape(module) + r"\b", original):
            continue
        replacement = vfs_dir / f"{hashlib.sha256(path.encode()).hexdigest()[:12]}-{Path(path).name}"
        write_private(replacement, f"// Cali Clean project-local VFS overlay: duplicate {module} definition removed.\n" + strip_module(original, module))
        roots.setdefault(str(Path(path).parent), []).append(
            {"type": "file", "name": Path(path).name, "external-contents": str(replacement)}
        )
        hidden.append({"path": path, "module": module, "replacement": str(replacement)})
    if not hidden:
        shutil.rmtree(vfs_dir)
        return None
    overlay = {
        "version": 0,
        "case-sensitive": "false",
        "roots": [{"type": "directory", "name": name, "contents": contents} for name, contents in sorted(roots.items())],
    }
    overlay_path = vfs_dir / "overlay.yaml"
    write_private(overlay_path, json.dumps(overlay, indent=2) + "\n")
    return {
        "path": str(overlay_path),
        "hidden": hidden,
        "flags": ["-vfsoverlay", str(overlay_path), "-Xcc", "-ivfsoverlay", "-Xcc", str(overlay_path)],
        "sha256": sha256_file(overlay_path),
    }


def build_renderers(
    toolchain: Toolchain,
    logs: List[Dict[str, Any]],
    log_dir: Path,
    runner: Runner = run_diag,
    backend: Optional[str] = None,
) -> Dict[str, Any]:
    """Build encoder and inspector with one coherent backend.

    Order: Swift; Swift with a project-local VFS overlay when the only problem is a
    duplicated module definition; then Objective-C for both. Real Swift code errors
    are never masked. CALI_CLEAN_RENDER_BACKEND=objc|swift lets an operator pin one.
    """
    backend = backend or requested_backend()
    reason = "swiftc not available through xcrun"
    if backend == "objc":
        reason = f"{BACKEND_ENV}=objc requested by the operator"
    elif toolchain.swiftc:
        try:
            return {
                "backend": "swift",
                "render": compile_swift(toolchain, "render_mp4", SRC_DIR / "render_mp4.swift", logs, log_dir, runner),
                "inspect": compile_swift(toolchain, "inspect_mp4", SRC_DIR / "inspect_mp4.swift", logs, log_dir, runner),
                "fallback_reason": None,
                "overlay": None,
            }
        except CompileError as exc:
            reason = swift_incompatibility(exc.output)
            if reason is None:
                raise
            overlay = swiftbridging_overlay(exc.output, toolchain, ROOT / ".build")
            if overlay:
                logs.append({"step": "swift:vfs-overlay", "overlay": overlay["path"], "hidden": overlay["hidden"]})
                try:
                    return {
                        "backend": "swift-vfs",
                        "render": compile_swift(toolchain, "render_mp4-vfs", SRC_DIR / "render_mp4.swift", logs, log_dir, runner,
                                                overlay["flags"], overlay["sha256"]),
                        "inspect": compile_swift(toolchain, "inspect_mp4-vfs", SRC_DIR / "inspect_mp4.swift", logs, log_dir, runner,
                                                 overlay["flags"], overlay["sha256"]),
                        "fallback_reason": reason,
                        "overlay": overlay,
                    }
                except CompileError as retry:
                    second = swift_incompatibility(retry.output)
                    if second is None:
                        raise
                    reason = f"{reason} (still after VFS overlay: {second})"
    if backend == "swift":
        raise ToolchainError(f"{BACKEND_ENV}=swift but Swift is unusable: {reason}")
    if not toolchain.clang:
        raise ToolchainError(f"Swift is unusable ({reason}) and clang is not available for the Objective-C fallback")
    logs.append({"step": "fallback:objc", "reason": reason})
    return {
        "backend": "objc",
        "render": compile_objc(toolchain, "render_mp4-objc", SRC_DIR / "render_mp4.m", logs, log_dir, runner),
        "inspect": compile_objc(toolchain, "inspect_mp4-objc", SRC_DIR / "inspect_mp4.m", logs, log_dir, runner),
        "fallback_reason": reason,
        "overlay": None,
    }


# --- Rendering --------------------------------------------------------------------------


def output_paths(runtime: Dict[str, Any], draft_id: str) -> Dict[str, Path]:
    review = storage_path(runtime, "review")
    drafts = storage_path(runtime, "drafts") / draft_id
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


def check_card_dependencies() -> str:
    """Pillow must load the pinned Manrope WOFF2 with variable weights (FreeType + brotli + variations)."""
    try:
        return motion.check_dependencies(ASSET_ROOT / "assets" / "manrope.woff2")
    except ImportError as exc:
        raise PolicyError(f"Pillow is not installed for this Python ({sys.executable}): {exc}")
    except OSError as exc:
        raise PolicyError(f"Pillow cannot load assets/manrope.woff2 with variable weights: {exc}")


def motion_plan_from(manifest: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "scenes": manifest["scenes"],
        "asset_id": manifest["asset_id"],
        "total_frames": manifest["output"]["frames"],
        "disclosure": manifest["disclosure"],
    }


def qa_frames(renderer: "motion.Renderer", contact_path: Path) -> Dict[str, Any]:
    """Safe zones for every scene, no empty frames on a 0.5 s grid, and a contact sheet of >= 8 moments."""
    for layout in renderer.layouts:
        for name, box in motion.layout_boxes(layout).items():
            if not motion.inside(box, motion.SAFE):
                raise PolicyError(f"{name} leaves the Reels safe zone: {box}")
    step = max(1, motion.FPS // 2)
    checked = 0
    for frame_index in range(0, renderer.plan["total_frames"], step):
        motion.assert_not_empty(renderer.frame(frame_index), f"#{frame_index}")
        checked += 1
    sheet = motion.contact_sheet(renderer, contact_path)
    contact_path.chmod(0o600)
    return {"empty_frame_checks": checked, "contact_sheet": sheet}


def validate_video_metadata(metadata: Dict[str, Any], output: Dict[str, Any]) -> None:
    if round(float(metadata["width"])) != int(output["width"]) or round(float(metadata["height"])) != int(output["height"]):
        raise PolicyError(f"Rendered dimensions do not match the 9:16 target: {metadata}")
    duration = float(metadata["duration"])
    if not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
        raise PolicyError(f"Rendered duration {duration:.2f}s is outside {MIN_DURATION_SECONDS:g}–{MAX_DURATION_SECONDS:g}s")
    if abs(duration - float(output["duration_seconds"])) > DURATION_TOLERANCE_SECONDS:
        raise PolicyError(f"Rendered duration does not match target: {metadata}")
    if "fps" in metadata and abs(float(metadata["fps"]) - float(output["fps"])) > 0.5:
        raise PolicyError(f"Rendered frame rate does not match target: {metadata}")
    if metadata.get("codec_fourcc") not in ALLOWED_CODECS:
        raise PolicyError(f"Unexpected video codec: {metadata.get('codec_fourcc')}")
    if metadata.get("decodable") is not True:
        raise PolicyError("Rendered MP4 could not be decoded at its first and last frames")
    if metadata.get("audio_tracks", 0) != 0:
        raise PolicyError("Rendered MP4 must not contain audio")


def _run_logged(command: List[str], timeout: int, step: str, log_dir: Path, logs: List[Dict[str, Any]], runner: Runner) -> subprocess.CompletedProcess:
    result = runner(command, timeout)
    log_path = log_dir / f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-{step}.log"
    write_private(log_path, diagnostic_log(command, result))
    logs.append({"step": step, "exit_code": result.returncode, "log": str(log_path)})
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout or "").strip().splitlines()[-25:])
        raise PolicyError(f"{step} failed (exit {result.returncode}); full diagnostics: {log_path}\n{tail}")
    return result


def stream_frames(
    command: List[str],
    frames: Iterable[bytes],
    timeout: int,
    step: str,
    log_dir: Path,
    logs: List[Dict[str, Any]],
) -> subprocess.CompletedProcess:
    """Pipe raw frames into the encoder's stdin with a wall-clock watchdog; log everything."""
    import tempfile
    import threading

    sent = 0
    broken = False
    with tempfile.TemporaryFile() as out_f, tempfile.TemporaryFile() as err_f:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out_f, stderr=err_f)
        watchdog = threading.Timer(timeout, process.kill)
        watchdog.start()
        try:
            for chunk in frames:
                try:
                    process.stdin.write(chunk)
                except BrokenPipeError:
                    broken = True
                    break
                sent += 1
            try:
                process.stdin.close()
            except BrokenPipeError:
                broken = True
            code = process.wait()
        except BaseException:
            process.kill()
            process.wait()
            raise
        finally:
            watchdog.cancel()
        out_f.seek(0)
        err_f.seek(0)
        result = subprocess.CompletedProcess(command, code, out_f.read().decode("utf-8", "replace"), err_f.read().decode("utf-8", "replace"))
    log_path = log_dir / f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-{step}.log"
    write_private(log_path, diagnostic_log(command, result, {"frames_sent": sent, "broken_pipe": broken}))
    logs.append({"step": step, "exit_code": code, "frames_sent": sent, "log": str(log_path)})
    if code != 0 or broken:
        tail = "\n".join((result.stderr or result.stdout or "").strip().splitlines()[-25:])
        raise PolicyError(f"{step} failed (exit {code}, {sent} frames sent); full diagnostics: {log_path}\n{tail}")
    return result


def render_video(
    manifest: Dict[str, Any],
    brand: Dict[str, Any],
    runtime: Dict[str, Any],
    paths: Dict[str, Path],
    built: Dict[str, Any],
    logs: List[Dict[str, Any]],
    runner: Runner = run_diag,
    streamer: Callable[..., subprocess.CompletedProcess] = stream_frames,
) -> Dict[str, Any]:
    log_dir = storage_path(runtime, "logs")
    private_dir(log_dir)
    private_dir(paths["draft_dir"])
    renderer = motion.Renderer(motion_plan_from(manifest), brand, ASSET_ROOT)
    qa = qa_frames(renderer, paths["draft_dir"] / "contact-sheet.png")
    ensure_not_killed(runtime)
    output = manifest["output"]
    command = [
        str(built["render"]), str(paths["video"]),
        str(output["width"]), str(output["height"]), str(output["fps"]), str(output["frames"]),
    ]
    completed = streamer(command, renderer.frames(), RENDER_TIMEOUT_SECONDS, "render", log_dir, logs)
    paths["video"].chmod(0o600)
    inspected = _run_logged([str(built["inspect"]), str(paths["video"])], 120, "inspect", log_dir, logs, runner)
    metadata = json.loads(inspected.stdout.strip())
    validate_video_metadata(metadata, output)
    return {
        "engine": "Pillow motion frames → macOS AVFoundation H.264",
        "backend": built["backend"],
        "fallback_reason": built["fallback_reason"],
        "vfs_overlay": built.get("overlay"),
        "provider_cost": 0,
        "rendered_at": now_local(runtime).isoformat(),
        "video": str(paths["video"]),
        "sha256": sha256_file(paths["video"]),
        "bytes": paths["video"].stat().st_size,
        "metadata": metadata,
        "qa": qa,
        "renderer_output": completed.stdout.strip(),
        "logs": logs,
    }


def preflight(runtime: Dict[str, Any], brand: Dict[str, Any], topics: Dict[str, Any], slot: datetime) -> Dict[str, Any]:
    """Everything except encoding: toolchain + encoder build, plan, layout, frame QA and a contact sheet.

    Writes only under var/state/preflight and .build; never a draft, an MP4 or a ledger entry.
    """
    log_dir = storage_path(runtime, "logs")
    private_dir(log_dir)
    logs: List[Dict[str, Any]] = []
    toolchain = resolve_toolchain()
    deps = check_card_dependencies()
    built = build_renderers(toolchain, logs, log_dir)
    plan = choose_plan(slot, brand, topics)
    manifest = build_storyboard(plan, brand, runtime, topics)
    validate_branding(manifest, brand)
    renderer = motion.Renderer(motion_plan_from(manifest), brand, ASSET_ROOT)
    target = storage_path(runtime, "state") / "preflight"
    private_dir(target)
    qa = qa_frames(renderer, target / f"{manifest['draft_id']}-contact-sheet.png")
    return {
        "status": "preflight_ok",
        "rendered": False,
        "draft_id": manifest["draft_id"],
        "script_id": manifest["script_id"],
        "language": manifest["language"],
        "duration_seconds": manifest["output"]["duration_seconds"],
        "frames": manifest["output"]["frames"],
        "scenes": [{"kind": s["kind"], "seconds": round(s["end"] - s["start"], 2), "headline": s["headline"]} for s in manifest["scenes"]],
        "hook_lands_at": manifest["scenes"][0]["headline_done"],
        "backend": built["backend"],
        "fallback_reason": built["fallback_reason"],
        "vfs_overlay": built.get("overlay"),
        "dependencies": deps,
        "contrast": motion.validate_contrast(brand),
        "qa": qa,
        "quota": quota_status(runtime, now_local(runtime)),
        "logs": logs,
    }


# --- Healthcheck ------------------------------------------------------------------------


def healthcheck(runtime: Dict[str, Any], brand: Dict[str, Any], toolchain_resolver: Callable[[], Toolchain] = resolve_toolchain) -> Dict[str, Any]:
    """Read-only readiness report; compiles nothing, renders nothing, opens no network."""
    checks: List[Dict[str, Any]] = []

    def check(name: str, fn: Callable[[], Any]) -> None:
        try:
            detail = fn()
            checks.append({"name": name, "ok": True, "detail": detail if detail is not None else "ok"})
        except Exception as exc:  # report every failure instead of stopping at the first
            checks.append({"name": name, "ok": False, "detail": str(exc)})

    def flags() -> str:
        names = ("render_enabled", "routine_enabled", "publication_enabled", "meta_connected")
        states = {key: bool(runtime.get(key)) for key in names}
        if any(states.values()):
            raise PolicyError(f"Expected all false: {states}")
        return "render/routine/publication/meta all false"

    def kill() -> str:
        reason = kill_switch_reason(runtime)
        if reason:
            raise PolicyError(f"engaged via {reason}")
        return "not engaged"

    def lock() -> str:
        if not lock_is_free(runtime):
            raise PolicyError("held by another run")
        return "free"

    def quota() -> Dict[str, Any]:
        status = quota_status(runtime, now_local(runtime))
        if status["exhausted"] and not status["override_available"]:
            raise PolicyError(f"{status['exhausted']}; daily override already used")
        if status["exhausted"]:
            status["note"] = "normal quota exhausted; one supervised override remains (render-pilot --supervised --quota-override-reason ...)"
        return status

    def disk() -> str:
        free = shutil.disk_usage(ROOT).free
        if free < MIN_FREE_BYTES:
            raise PolicyError(f"only {free // (1024 * 1024)} MiB free")
        return f"{free // (1024 * 1024)} MiB free"

    def toolchain() -> Dict[str, str]:
        tc = toolchain_resolver()
        return {
            "swiftc": tc.swiftc or "unavailable", "swiftc_version": tc.swiftc_version,
            "clang": tc.clang or "unavailable", "clang_version": tc.clang_version,
            "sdk": tc.sdk_path, "sdk_version": tc.sdk_version, "target": tc.target,
            "order": "swift first; objective-c fallback only on toolchain/SDK incompatibility",
        }

    check("brand_integrity", lambda: validate_brand(brand))
    check("runtime_safe", lambda: ensure_runtime_safe(runtime))
    check("zero_cost", lambda: ensure_zero_cost(runtime))
    check("activation_flags_false", flags)
    check("kill_switch", kill)
    check("lock", lock)
    check("quota", quota)
    check("retention_due", lambda: prune(runtime, now_local(runtime), dry_run=True))
    check("disk_space", disk)
    check("card_dependencies", check_card_dependencies)
    check("toolchain", toolchain)
    return {"healthy": all(item["ok"] for item in checks), "checks": checks}


# --- Entry point ------------------------------------------------------------------------


def run(command: str, slot_value: str | None, supervised: bool = False, override_reason: Optional[str] = None) -> Dict[str, Any]:
    override_reason = validate_override_reason(override_reason)
    if override_reason is not None and not (command == "render-pilot" and supervised):
        raise PolicyError("--quota-override-reason is only accepted with render-pilot --supervised")
    brand = load_json(BRAND_PATH)
    topics = load_json(TOPICS_PATH)
    runtime = load_json(RUNTIME_PATH)
    validate_brand(brand)
    ensure_runtime_safe(runtime)
    meta_status = DisabledMetaAdapter(runtime).status()

    if command == "healthcheck":
        report = healthcheck(runtime, brand)
        report["meta"] = meta_status
        return report

    slot = parse_slot(slot_value, runtime["timezone"])
    rendering = command in {"render-pilot", "hourly"}

    if command == "hourly":
        if not runtime.get("routine_enabled"):
            raise PolicyError("Hourly routine is disabled in config/runtime.json")
        if not runtime.get("render_enabled"):
            raise PolicyError("Hourly rendering is disabled in config/runtime.json")
    if command == "render-pilot" and not supervised:
        raise PolicyError("render-pilot requires --supervised (a human must be watching this one render)")
    if rendering:
        ensure_not_killed(runtime)

    with exclusive_lock(runtime):
        if command == "preflight":
            report = preflight(runtime, brand, topics, slot)
            report["meta"] = meta_status
            return report
        if command == "hourly":
            prune(runtime, now_local(runtime))

        plan = choose_plan(slot, brand, topics)
        manifest = build_storyboard(plan, brand, runtime, topics)
        validate_branding(manifest, brand)
        paths = output_paths(runtime, manifest["draft_id"])

        if paths["manifest"].exists():
            existing = load_json(paths["manifest"])
            # A dry-run manifest for this slot may be upgraded by one render; anything else is final.
            if not (rendering and existing.get("status") == "dry_run"):
                return {"status": "idempotent_existing", "manifest": str(paths["manifest"]), "draft": existing}

        if rendering:
            toolchain = resolve_toolchain()
            check_card_dependencies()
            quota = enforce_render_quota(runtime, now_local(runtime), override_reason)
            # Encoders are built before the attempt is recorded: a compiler problem never spends quota.
            log_dir = storage_path(runtime, "logs")
            private_dir(log_dir)
            logs: List[Dict[str, Any]] = []
            built = build_renderers(toolchain, logs, log_dir)
            if quota["override"]:
                append_ledger(runtime, {
                    "event": "quota_override", "draft_id": manifest["draft_id"], "at": now_local(runtime).isoformat(),
                    "reason": override_reason, "command": command, "supervised": True,
                    "usage": {"attempts": quota["attempts"], "completed": quota["completed"]},
                })
            append_ledger(runtime, {"event": "started", "draft_id": manifest["draft_id"], "at": now_local(runtime).isoformat(),
                                    "quota_override": quota["override"]})
            try:
                manifest["render"] = render_video(manifest, brand, runtime, paths, built, logs)
            except Exception as exc:
                append_ledger(runtime, {"event": "failed", "draft_id": manifest["draft_id"], "at": now_local(runtime).isoformat(), "error": str(exc)[:500]})
                raise
            manifest["status"] = "qa_pending"
            append_ledger(runtime, {"event": "completed", "draft_id": manifest["draft_id"], "at": manifest["render"]["rendered_at"], "provider_cost": 0})

        persist_manifest(manifest, runtime)
        return {
            "status": manifest["status"],
            "draft_id": manifest["draft_id"],
            "manifest": str(paths["manifest"]),
            "storyboard": str(paths["storyboard"]),
            "video": str(paths["video"]) if paths["video"].exists() else None,
            "render": manifest.get("render"),
            "publication_enabled": False,
            "meta": meta_status,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("dry-run", "preflight", "render-pilot", "hourly", "healthcheck"))
    parser.add_argument("--slot", help="ISO timestamp; rounded down to the hour")
    parser.add_argument("--supervised", action="store_true", help="required for render-pilot")
    parser.add_argument("--quota-override-reason", help="render-pilot --supervised only: one extra attempt per day after the normal quota is spent")
    args = parser.parse_args()
    try:
        result = run(args.command, args.slot, supervised=args.supervised, override_reason=args.quota_override_reason)
    except (PolicyError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, default=str))
    if args.command == "healthcheck" and not result["healthy"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
