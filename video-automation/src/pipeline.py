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
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional
from zoneinfo import ZoneInfo

SRC_DIR = Path(__file__).resolve().parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from meta_adapter import DisabledMetaAdapter  # noqa: E402  (offline, no network imports)

ROOT = SRC_DIR.parent
BRAND_PATH = ROOT / "config" / "brand.json"
TOPICS_PATH = ROOT / "config" / "topics.json"
RUNTIME_PATH = ROOT / "config" / "runtime.json"
DISCLOSURE_EN = "Illustrative AI-generated visual — not client work or company personnel."
DISCLOSURE_ES = "Imagen ilustrativa generada con IA; no representa clientes ni personal."

# Output contract for reviewable Reels-style drafts.
OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
MIN_DURATION_SECONDS = 12.0
MAX_DURATION_SECONDS = 20.0
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


def validate_branding(manifest: Dict[str, Any], brand: Dict[str, Any]) -> None:
    """Every draft must close on the official CTA and carry the AI-visual disclosure."""
    lang = manifest["language"]
    scenes = manifest["scenes"]
    if len(scenes) != 4:
        raise PolicyError("Storyboard must have exactly four scenes")
    final = scenes[-1]
    if final["headline"] != brand["cta"][lang] or "cali-clean.net" not in final["headline"]:
        raise PolicyError("Final scene must carry the official cali-clean.net CTA")
    if final["body"] != brand["content_rules"]["required_visual_disclosure"][lang]:
        raise PolicyError("Final scene must carry the required visual disclosure")
    if not any(scene["eyebrow"] == "CALI CLEAN" for scene in scenes):
        raise PolicyError("Storyboard must name the Cali Clean brand")
    if manifest["asset_id"] not in {asset["id"] for asset in brand["assets"]}:
        raise PolicyError(f"Unknown brand asset: {manifest['asset_id']}")
    previous_end = 0.0
    for scene in scenes:
        if abs(scene["start"] - previous_end) > 1e-6 or scene["end"] <= scene["start"]:
            raise PolicyError("Scenes must be contiguous and non-empty")
        previous_end = scene["end"]
    if abs(previous_end - float(manifest["output"]["duration_seconds"])) > 1e-6:
        raise PolicyError("Storyboard must cover the full output duration")


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


def validate_output_spec(output: Dict[str, Any]) -> None:
    if int(output["width"]) != OUTPUT_WIDTH or int(output["height"]) != OUTPUT_HEIGHT:
        raise PolicyError(f"Output must be {OUTPUT_WIDTH}x{OUTPUT_HEIGHT}")
    duration = float(output["duration_seconds"])
    if not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
        raise PolicyError(f"Output duration must be {MIN_DURATION_SECONDS:g}–{MAX_DURATION_SECONDS:g} s")
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
) -> Path:
    build_dir = ROOT / ".build"
    private_dir(build_dir)
    binary = build_dir / name
    stamp = build_dir / f"{name}.stamp"
    expected = hashlib.sha256((sha256_file(source) + toolchain.fingerprint()).encode()).hexdigest()
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


def compile_swift(toolchain: Toolchain, name: str, source: Path, logs: List[Dict[str, Any]], log_dir: Path, runner: Runner = run_diag) -> Path:
    return _compile(toolchain, name, source, logs, log_dir, runner, "swiftc", swiftc_command)


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


def build_renderers(
    toolchain: Toolchain,
    logs: List[Dict[str, Any]],
    log_dir: Path,
    runner: Runner = run_diag,
) -> Dict[str, Any]:
    """Build renderer and inspector with one coherent backend: Swift first, else Objective-C for both."""
    reason = "swiftc not available through xcrun"
    if toolchain.swiftc:
        try:
            return {
                "backend": "swift",
                "render": compile_swift(toolchain, "render_mp4", SRC_DIR / "render_mp4.swift", logs, log_dir, runner),
                "inspect": compile_swift(toolchain, "inspect_mp4", SRC_DIR / "inspect_mp4.swift", logs, log_dir, runner),
                "fallback_reason": None,
            }
        except CompileError as exc:
            reason = swift_incompatibility(exc.output)
            if reason is None:
                raise
    if not toolchain.clang:
        raise ToolchainError(f"Swift is unusable ({reason}) and clang is not available for the Objective-C fallback")
    logs.append({"step": "fallback:objc", "reason": reason})
    return {
        "backend": "objc",
        "render": compile_objc(toolchain, "render_mp4-objc", SRC_DIR / "render_mp4.m", logs, log_dir, runner),
        "inspect": compile_objc(toolchain, "inspect_mp4-objc", SRC_DIR / "inspect_mp4.m", logs, log_dir, runner),
        "fallback_reason": reason,
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


def check_card_dependencies() -> str:
    """Pillow must be importable and able to load the pinned Manrope WOFF2 (needs FreeType+brotli)."""
    try:
        import PIL
        _fonts()
    except ImportError as exc:
        raise PolicyError(f"Pillow is not installed for this Python ({sys.executable}): {exc}")
    except OSError as exc:
        raise PolicyError(f"Pillow cannot load assets/manrope.woff2 (FreeType without WOFF2/brotli?): {exc}")
    return f"Pillow {PIL.__version__}"


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


def validate_video_metadata(metadata: Dict[str, Any], output: Dict[str, Any]) -> None:
    if round(float(metadata["width"])) != int(output["width"]) or round(float(metadata["height"])) != int(output["height"]):
        raise PolicyError(f"Rendered dimensions do not match the 9:16 target: {metadata}")
    duration = float(metadata["duration"])
    if not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
        raise PolicyError(f"Rendered duration {duration:.2f}s is outside {MIN_DURATION_SECONDS:g}–{MAX_DURATION_SECONDS:g}s")
    if abs(duration - float(output["duration_seconds"])) > DURATION_TOLERANCE_SECONDS:
        raise PolicyError(f"Rendered duration does not match target: {metadata}")
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


def render_video(
    manifest: Dict[str, Any],
    brand: Dict[str, Any],
    runtime: Dict[str, Any],
    paths: Dict[str, Path],
    toolchain: Toolchain,
    runner: Runner = run_diag,
) -> Dict[str, Any]:
    log_dir = storage_path(runtime, "logs")
    private_dir(log_dir)
    logs: List[Dict[str, Any]] = []
    built = build_renderers(toolchain, logs, log_dir, runner)
    render_bin, inspect_bin = built["render"], built["inspect"]
    ensure_not_killed(runtime)
    cards = render_cards(manifest, brand, runtime, paths["draft_dir"])
    output = runtime["output"]
    command = [
        str(render_bin), str(paths["video"]),
        str(output["width"]), str(output["height"]), str(output["fps"]), str(output["duration_seconds"]),
        *[str(path) for path in cards],
    ]
    completed = _run_logged(command, 300, "render", log_dir, logs, runner)
    paths["video"].chmod(0o600)
    inspected = _run_logged([str(inspect_bin), str(paths["video"])], 120, "inspect", log_dir, logs, runner)
    metadata = json.loads(inspected.stdout.strip())
    validate_video_metadata(metadata, output)
    return {
        "engine": "macOS AVFoundation",
        "backend": built["backend"],
        "fallback_reason": built["fallback_reason"],
        "provider_cost": 0,
        "rendered_at": now_local(runtime).isoformat(),
        "toolchain": {
            "swiftc": toolchain.swiftc,
            "swiftc_version": toolchain.swiftc_version,
            "clang": toolchain.clang,
            "clang_version": toolchain.clang_version,
            "sdk": toolchain.sdk_path,
            "sdk_version": toolchain.sdk_version,
            "target": toolchain.target,
        },
        "video": str(paths["video"]),
        "sha256": sha256_file(paths["video"]),
        "bytes": paths["video"].stat().st_size,
        "metadata": metadata,
        "renderer_output": completed.stdout.strip(),
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
        if command == "hourly":
            prune(runtime, now_local(runtime))

        plan = choose_plan(slot, brand, topics)
        manifest = build_storyboard(plan, brand, runtime)
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
            if quota["override"]:
                append_ledger(runtime, {
                    "event": "quota_override", "draft_id": manifest["draft_id"], "at": now_local(runtime).isoformat(),
                    "reason": override_reason, "command": command, "supervised": True,
                    "usage": {"attempts": quota["attempts"], "completed": quota["completed"]},
                })
            append_ledger(runtime, {"event": "started", "draft_id": manifest["draft_id"], "at": now_local(runtime).isoformat(),
                                    "quota_override": quota["override"]})
            try:
                manifest["render"] = render_video(manifest, brand, runtime, paths, toolchain)
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
    parser.add_argument("command", choices=("dry-run", "render-pilot", "hourly", "healthcheck"))
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
