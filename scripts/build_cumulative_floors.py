#!/usr/bin/env python3
"""Build structurally shared cumulative upper-floor Deep Zoom tiles.

Each output object is written only when a source floor changes a tile.  The
manifest lets the viewer resolve an arbitrary floor to the most recent object
at or below that floor, so unchanged tiles do not need to be copied into every
logical floor view.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

from PIL import Image


SCHEMA = "fanmap42.cumulative-floors.v1"
LAYER_RE = re.compile(r"^layer(\d+)_files$")
TILE_RE = re.compile(r"^(\d+)_(\d+)\.webp$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--release", required=True)
    parser.add_argument("--base-release", required=True)
    parser.add_argument("--family", action="append", dest="families")
    parser.add_argument("--max-floor", type=int, default=29)
    parser.add_argument("--workers", type=int, default=max(1, os.cpu_count() or 1))
    parser.add_argument("--quality", type=int, default=80)
    parser.add_argument("--method", type=int, choices=range(0, 7), default=2)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def alpha_pixels(image: Image.Image) -> int:
    histogram = image.getchannel("A").histogram()
    return sum(histogram[1:])


def link_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)


def process_chain(task: dict) -> dict:
    input_root = Path(task["input"])
    output_root = Path(task["output"])
    family = task["family"]
    level = task["level"]
    x = task["x"]
    y = task["y"]
    quality = task["quality"]
    method = task["method"]
    current: Image.Image | None = None
    events = []

    for floor in task["floors"]:
        source = input_root / family / f"layer{floor}_files" / str(level) / f"{x}_{y}.webp"
        with Image.open(source) as opened:
            delta = opened.convert("RGBA")
        delta_alpha = alpha_pixels(delta)
        changed = True

        destination = (
            output_root
            / f"{family}_cumulative"
            / f"layer{floor}_files"
            / str(level)
            / f"{x}_{y}.webp"
        )
        if current is None:
            current = delta
            if not destination.exists():
                link_or_copy(source, destination)
        else:
            composed = Image.alpha_composite(current, delta)
            if composed.tobytes() == current.tobytes():
                changed = False
            else:
                current = composed
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary = destination.with_suffix(".webp.tmp")
                current.save(
                    temporary,
                    format="WEBP",
                    quality=quality,
                    method=method,
                    exact=True,
                )
                os.replace(temporary, destination)

        events.append(
            {
                "floor": floor,
                "delta_alpha": delta_alpha,
                "changed": changed,
                "cumulative_alpha": alpha_pixels(current),
                "bytes": destination.stat().st_size if changed else 0,
            }
        )

    return {
        "chain": f"{family}/{level}/{x}_{y}",
        "family": family,
        "level": level,
        "x": x,
        "y": y,
        "events": events,
    }


def dzi_info(path: Path) -> dict:
    root = ET.parse(path).getroot()
    namespace = "{http://schemas.microsoft.com/deepzoom/2008}"
    size = root.find(f"{namespace}Size")
    if size is None:
        raise ValueError(f"missing DZI Size: {path}")
    return {
        "width": int(size.attrib["Width"]),
        "height": int(size.attrib["Height"]),
        "tile_size": int(root.attrib["TileSize"]),
        "tile_overlap": int(root.attrib["Overlap"]),
        "file_format": "webp",
    }


def scan_tasks(options: argparse.Namespace) -> tuple[list[dict], dict]:
    families = options.families or ["base", "base_top"]
    tasks: dict[tuple[str, int, int, int], list[int]] = defaultdict(list)
    family_info = {}
    for family in families:
        family_root = options.input / family
        descriptor = family_root / "layer0.dzi"
        if not descriptor.is_file():
            raise FileNotFoundError(descriptor)
        family_info[family] = dzi_info(descriptor)
        for directory in family_root.iterdir():
            match = LAYER_RE.match(directory.name)
            if not match or not directory.is_dir():
                continue
            floor = int(match.group(1))
            if floor < 1 or floor > options.max_floor:
                continue
            for level_directory in directory.iterdir():
                if not level_directory.is_dir() or not level_directory.name.isdigit():
                    continue
                level = int(level_directory.name)
                for tile in level_directory.iterdir():
                    tile_match = TILE_RE.match(tile.name)
                    if tile_match and tile.is_file():
                        x, y = map(int, tile_match.groups())
                        tasks[(family, level, x, y)].append(floor)

    result = []
    for (family, level, x, y), floors in sorted(tasks.items()):
        result.append(
            {
                "input": str(options.input),
                "output": str(options.output),
                "family": family,
                "level": level,
                "x": x,
                "y": y,
                "floors": sorted(floors),
                "quality": options.quality,
                "method": options.method,
            }
        )
    return result, family_info


def changed_rows(points: list[tuple[int, int]]) -> dict[str, list[list[int]]]:
    levels: dict[int, dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
    for level, packed in points:
        x = packed >> 32
        y = packed & 0xFFFFFFFF
        levels[level][y].append(x)
    output = {}
    for level, rows in sorted(levels.items()):
        encoded_rows = []
        for y, xs in sorted(rows.items()):
            xs = sorted(set(xs))
            row = [y]
            start = previous = xs[0]
            for x in xs[1:]:
                if x == previous + 1:
                    previous = x
                    continue
                row.extend([start, previous])
                start = previous = x
            row.extend([start, previous])
            encoded_rows.append(row)
        output[str(level)] = encoded_rows
    return output


def coverage_rows(points: list[tuple[int, int, int]]) -> dict[str, list[list[int]]]:
    levels: dict[int, dict[int, list[tuple[int, int]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for level, packed, coverage in points:
        x = packed >> 32
        y = packed & 0xFFFFFFFF
        levels[level][y].append((x, coverage))
    output = {}
    for level, rows in sorted(levels.items()):
        output[str(level)] = [
            [y, *[value for pair in sorted(values) for value in pair]]
            for y, values in sorted(rows.items())
        ]
    return output


def build_manifest(options: argparse.Namespace, family_info: dict, records: list[dict]) -> dict:
    changes = defaultdict(lambda: defaultdict(list))
    coverage = defaultdict(lambda: defaultdict(list))
    delta_coverage = defaultdict(lambda: defaultdict(list))
    changed_count = 0
    delta_count = 0
    total_bytes = 0

    for record in records:
        family = record["family"]
        level = record["level"]
        packed = (record["x"] << 32) | record["y"]
        for event in record["events"]:
            floor = event["floor"]
            delta_count += 1
            delta_coverage[family][floor].append((level, packed, event["delta_alpha"]))
            if event["changed"]:
                changed_count += 1
                total_bytes += event["bytes"]
                changes[family][floor].append((level, packed))
                coverage[family][floor].append(
                    (level, packed, event["cumulative_alpha"])
                )

    families = {}
    for family, info in family_info.items():
        floors = sorted(changes[family])
        families[family] = {
            **info,
            "output_source": f"{family}_cumulative",
            "min_floor": min(floors) if floors else 1,
            "max_floor": max(floors) if floors else options.max_floor,
            "changes": {
                str(floor): changed_rows(changes[family][floor]) for floor in floors
            },
            "coverage": {
                str(floor): coverage_rows(coverage[family][floor]) for floor in floors
            },
            "delta_coverage": {
                str(floor): coverage_rows(delta_coverage[family][floor])
                for floor in sorted(delta_coverage[family])
            },
        }

    return {
        "schema": SCHEMA,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "release": options.release,
        "base_release": options.base_release,
        "tile_count": changed_count,
        "delta_tile_count": delta_count,
        "total_bytes": total_bytes,
        "families": families,
    }


def load_records(path: Path) -> tuple[list[dict], set[str]]:
    records = []
    completed = set()
    if not path.exists():
        return records, completed
    with path.open() as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid state line {line_number}: {error}") from error
            records.append(record)
            completed.add(record["chain"])
    return records, completed


def main() -> int:
    options = parse_args()
    options.input = options.input.resolve()
    options.output = options.output.resolve()
    if options.input == options.output or options.input in options.output.parents:
        raise ValueError("output must not be inside the input tree")
    if options.output.exists() and not options.resume:
        raise FileExistsError(f"output exists; use --resume: {options.output}")
    options.output.mkdir(parents=True, exist_ok=True)

    state_file = options.output / "records.jsonl"
    records, completed = load_records(state_file)
    tasks, family_info = scan_tasks(options)
    pending = [task for task in tasks if f'{task["family"]}/{task["level"]}/{task["x"]}_{task["y"]}' not in completed]
    print(
        json.dumps(
            {
                "chains": len(tasks),
                "completed": len(completed),
                "pending": len(pending),
                "workers": options.workers,
            }
        ),
        flush=True,
    )

    with state_file.open("a", buffering=1) as state, concurrent.futures.ProcessPoolExecutor(
        max_workers=options.workers
    ) as executor:
        futures = {executor.submit(process_chain, task): task for task in pending}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            result = future.result()
            records.append(result)
            state.write(json.dumps(result, separators=(",", ":")) + "\n")
            if index % 1000 == 0 or index == len(pending):
                print(
                    json.dumps(
                        {
                            "completed_this_run": index,
                            "pending": len(pending) - index,
                        }
                    ),
                    flush=True,
                )

    manifest = build_manifest(options, family_info, records)
    manifest_file = options.output / "cumulative-floor-v1.json"
    temporary = manifest_file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
    os.replace(temporary, manifest_file)
    (options.output / "build-state.json").write_text(
        json.dumps(
            {
                "status": "complete",
                "manifest": str(manifest_file),
                "tile_count": manifest["tile_count"],
                "delta_tile_count": manifest["delta_tile_count"],
                "total_bytes": manifest["total_bytes"],
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps(manifest | {"families": list(manifest["families"])}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise
