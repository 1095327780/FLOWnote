#!/usr/bin/env python3
"""Extract heading indices and chapter range stats from markdown.

This tool intentionally does NOT decide chapter hierarchy.
It only:
1) lists all H3 headings with line numbers
2) computes per-range stats for chapter line numbers provided by user/AI
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Iterable, cast


H3_RE = re.compile(r"^\s*###\s+(.+?)\s*$")
QUOTE_RE = re.compile(r"^\s*>\s+\S")
THOUGHT_RE = re.compile(r"^\s*-\s*💭\s+")
LIKELY_SUBCHAPTER_RE = re.compile(
    r"^(第[一二三四五六七八九十百零千]+(章|节|幕)|场景[一二三四五六七八九十百零千\d]+|\d+(\.\d+)+)"
)


def read_lines(file_path: Path) -> list[str]:
    try:
        return file_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        print(f"ERROR: file not found: {file_path}", file=sys.stderr)
        sys.exit(1)


def extract_h3(lines: list[str]) -> list[dict[str, object]]:
    items: list[dict[str, object]] = []
    for idx, line in enumerate(lines, start=1):
        match = H3_RE.match(line)
        if match:
            items.append(
                {"index": len(items) + 1, "line": idx, "title": match.group(1).strip()}
            )
    return items


def parse_chapter_lines(raw: str) -> list[int]:
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        print("ERROR: --chapter-lines cannot be empty", file=sys.stderr)
        sys.exit(1)
    try:
        numbers = sorted(set(int(p) for p in parts))
    except ValueError:
        print(
            "ERROR: --chapter-lines must be comma-separated integers", file=sys.stderr
        )
        sys.exit(1)
    return numbers


def group_count(flags: Iterable[bool]) -> int:
    count = 0
    in_group = False
    for flag in flags:
        if flag and not in_group:
            count += 1
            in_group = True
        elif not flag:
            in_group = False
    return count


def compute_ranges(lines: list[str], chapter_lines: list[int]) -> dict[str, object]:
    total_lines = len(lines)
    h3_index = {item["line"]: item["title"] for item in extract_h3(lines)}

    normalized = [ln for ln in chapter_lines if 1 <= ln <= total_lines]
    if not normalized:
        print("ERROR: no valid chapter line numbers in file range", file=sys.stderr)
        sys.exit(1)

    rows: list[dict[str, object]] = []
    total_highlights = 0
    total_thoughts = 0
    total_idea_blocks = 0

    for i, start in enumerate(normalized):
        end = normalized[i + 1] - 1 if i + 1 < len(normalized) else total_lines
        chunk = lines[start - 1 : end]

        highlight_count = sum(1 for ln in chunk if QUOTE_RE.match(ln))
        thought_count = sum(1 for ln in chunk if THOUGHT_RE.match(ln))

        markers = [bool(QUOTE_RE.match(ln) or THOUGHT_RE.match(ln)) for ln in chunk]
        idea_block_count = group_count(markers)

        total_highlights += highlight_count
        total_thoughts += thought_count
        total_idea_blocks += idea_block_count

        rows.append(
            {
                "chapter_index": i + 1,
                "chapter_title": h3_index.get(start, f"line-{start}"),
                "start_line": start,
                "end_line": end,
                "line_span": end - start + 1,
                "highlight_count": highlight_count,
                "thought_count": thought_count,
                "idea_block_count": idea_block_count,
            }
        )

    return {
        "total_lines": total_lines,
        "chapter_count": len(rows),
        "total_highlights": total_highlights,
        "total_thoughts": total_thoughts,
        "total_idea_blocks": total_idea_blocks,
        "chapters": rows,
    }


def collect_deeper_candidates(
    h3_items: list[dict[str, object]],
    chapter_lines: list[int],
    total_lines: int,
    expand_if_lte: int,
) -> list[dict[str, object]]:
    normalized = [ln for ln in chapter_lines if 1 <= ln <= total_lines]
    if not normalized:
        return []
    if len(normalized) > expand_if_lte:
        return []

    payload: list[dict[str, object]] = []
    for i, start in enumerate(normalized):
        end = normalized[i + 1] - 1 if i + 1 < len(normalized) else total_lines

        chapter_title = f"line-{start}"
        for h in h3_items:
            if h["line"] == start:
                chapter_title = str(h["title"])
                break

        children: list[dict[str, object]] = []
        for h in h3_items:
            line_no_obj = h["line"]
            if not isinstance(line_no_obj, int):
                continue
            line_no = line_no_obj
            if start < line_no <= end:
                title = str(h["title"])
                children.append(
                    {
                        "line": line_no,
                        "title": title,
                        "likely_subchapter": bool(LIKELY_SUBCHAPTER_RE.search(title)),
                    }
                )

        payload.append(
            {
                "chapter_index": i + 1,
                "chapter_title": chapter_title,
                "start_line": start,
                "end_line": end,
                "child_heading_count": len(children),
                "child_headings": children,
            }
        )

    return payload


def print_headings_table(file_path: Path, h3_items: list[dict[str, object]]) -> None:
    print(f"FILE: {file_path}")
    print(f"TOTAL_H3: {len(h3_items)}")
    print("INDEX\tLINE\tTITLE")
    for item in h3_items:
        print(f"{item['index']}\t{item['line']}\t{item['title']}")


def print_ranges_table(file_path: Path, payload: dict[str, object]) -> None:
    print(f"FILE: {file_path}")
    print(f"TOTAL_LINES: {payload['total_lines']}")
    print(f"CHAPTERS: {payload['chapter_count']}")
    print(f"HIGHLIGHTS: {payload['total_highlights']}")
    print(f"THOUGHTS: {payload['total_thoughts']}")
    print(f"IDEA_BLOCKS: {payload['total_idea_blocks']}")
    print("INDEX\tTITLE\tRANGE\tHIGHLIGHTS\tTHOUGHTS\tIDEA_BLOCKS")
    chapters = cast(list[dict[str, object]], payload["chapters"])
    for row in chapters:
        line_range = f"{row['start_line']}-{row['end_line']}"
        print(
            f"{row['chapter_index']}\t{row['chapter_title']}\t{line_range}\t"
            f"{row['highlight_count']}\t{row['thought_count']}\t{row['idea_block_count']}"
        )

    deeper = cast(list[dict[str, object]], payload.get("deeper_candidates", []))
    if deeper:
        print("\nDEEPER_CANDIDATES (top-level chapters <= threshold)")
        for ch in deeper:
            print(
                f"CHAPTER {ch['chapter_index']}\t{ch['chapter_title']}\t"
                f"RANGE {ch['start_line']}-{ch['end_line']}\t"
                f"CHILD_HEADINGS {ch['child_heading_count']}"
            )
            child_headings = cast(list[dict[str, object]], ch["child_headings"])
            for item in child_headings:
                likely = "Y" if item["likely_subchapter"] else "N"
                print(f"  - {item['line']}\t[{likely}]\t{item['title']}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract H3 headings and chapter range stats from markdown."
    )
    parser.add_argument(
        "mode",
        choices=["headings", "ranges"],
        help="headings: list all H3; ranges: compute stats",
    )
    parser.add_argument("file", help="markdown file path")
    parser.add_argument(
        "--chapter-lines",
        help="comma-separated chapter start line numbers for ranges mode",
    )
    parser.add_argument(
        "--expand-if-lte",
        type=int,
        default=5,
        help="when chapter count <= this value, output one-level deeper heading candidates",
    )
    parser.add_argument("--format", choices=["table", "json"], default="table")
    args = parser.parse_args()

    file_path = Path(args.file).expanduser().resolve()
    lines = read_lines(file_path)

    if args.mode == "headings":
        h3_items = extract_h3(lines)
        if args.format == "json":
            print(
                json.dumps(
                    {"file": str(file_path), "total_lines": len(lines), "h3": h3_items},
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print_headings_table(file_path, h3_items)
        return

    if not args.chapter_lines:
        print("ERROR: ranges mode requires --chapter-lines", file=sys.stderr)
        sys.exit(1)

    chapter_lines = parse_chapter_lines(args.chapter_lines)
    payload = compute_ranges(lines, chapter_lines)
    h3_items = extract_h3(lines)
    payload["deeper_candidates"] = collect_deeper_candidates(
        h3_items, chapter_lines, len(lines), args.expand_if_lte
    )
    payload["file"] = str(file_path)

    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print_ranges_table(file_path, payload)


if __name__ == "__main__":
    main()
