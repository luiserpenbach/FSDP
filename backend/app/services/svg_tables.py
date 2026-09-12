"""Server-side SVG pages for tabular exports (FMEA worksheets, safety review
packages). Pages are A3 landscape and convert to PDF with cairosvg, the same
path the sheet export uses, so documents generate without a browser."""

from __future__ import annotations

import html
from typing import Any

PAGE_W = 420.0
PAGE_H = 297.0
MARGIN = 12.0
HEADER_H = 16.0
ROW_H = 6.2
FONT = "Helvetica, Arial, sans-serif"
LINE = "#333333"
MUTED = "#666666"
ZEBRA = "#f2f4f6"
FONT_SIZE = 2.6
CHAR_W = 1.35  # approximate advance for FONT_SIZE, in mm


def _wrap(text: str, width_mm: float) -> list[str]:
    max_chars = max(4, int(width_mm / CHAR_W))
    words = str(text).split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            lines.append(current)
        while len(word) > max_chars:
            lines.append(word[:max_chars])
            word = word[max_chars:]
        current = word
    if current:
        lines.append(current)
    return lines or [""]


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:g}"
    if isinstance(value, list):
        return ", ".join(str(entry) for entry in value)
    return str(value)


def table_pages(
    title: str,
    subtitle: str,
    columns: list[tuple[str, str, float]],
    rows: list[dict[str, Any]],
    *,
    max_lines: int = 4,
    footer: str = "",
) -> list[str]:
    """SVG pages of a table. ``columns`` are (key, label, relative width)."""
    usable = PAGE_W - 2 * MARGIN
    total_weight = sum(weight for _, _, weight in columns) or 1
    widths = [usable * weight / total_weight for _, _, weight in columns]
    pages: list[str] = []
    index = 0
    page_no = 0
    while index < len(rows) or (page_no == 0 and not rows):
        page_no += 1
        parts: list[str] = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
            f'viewBox="0 0 {PAGE_W} {PAGE_H}" font-family="{FONT}">',
            f'<rect x="0" y="0" width="{PAGE_W}" height="{PAGE_H}" fill="#ffffff"/>',
            f'<text x="{MARGIN}" y="{MARGIN + 4}" font-size="5" font-weight="bold" fill="{LINE}">'
            f"{html.escape(title)}</text>",
            f'<text x="{MARGIN}" y="{MARGIN + 9}" font-size="2.8" fill="{MUTED}">'
            f"{html.escape(subtitle)}</text>",
            f'<text x="{PAGE_W - MARGIN}" y="{MARGIN + 4}" font-size="2.8" fill="{MUTED}" '
            f'text-anchor="end">Page {page_no}</text>',
        ]
        y = MARGIN + HEADER_H
        x = MARGIN
        parts.append(
            f'<rect x="{MARGIN}" y="{y - 4.2}" width="{usable}" height="{ROW_H}" fill="#dde3ea"/>'
        )
        for (_, label, _), width in zip(columns, widths, strict=True):
            parts.append(
                f'<text x="{x + 1}" y="{y}" font-size="{FONT_SIZE}" font-weight="bold" '
                f'fill="{LINE}">{html.escape(label)}</text>'
            )
            x += width
        y += ROW_H
        zebra = False
        while index < len(rows):
            row = rows[index]
            wrapped = [
                _wrap(_cell(row.get(key)), width - 2)[:max_lines]
                for (key, _, _), width in zip(columns, widths, strict=True)
            ]
            lines = max(len(cell) for cell in wrapped)
            height = ROW_H * max(1, lines) * 0.78 + 1.5
            if y + height > PAGE_H - MARGIN - 6:
                break
            if zebra:
                parts.append(
                    f'<rect x="{MARGIN}" y="{y - 4.2}" width="{usable}" height="{height}" '
                    f'fill="{ZEBRA}"/>'
                )
            zebra = not zebra
            x = MARGIN
            for cell, width in zip(wrapped, widths, strict=True):
                for line_no, line in enumerate(cell):
                    parts.append(
                        f'<text x="{x + 1}" y="{y + line_no * ROW_H * 0.78}" '
                        f'font-size="{FONT_SIZE}" fill="{LINE}">{html.escape(line)}</text>'
                    )
                x += width
            parts.append(
                f'<line x1="{MARGIN}" y1="{y + height - 4.2}" x2="{MARGIN + usable}" '
                f'y2="{y + height - 4.2}" stroke="#d7dee9" stroke-width="0.2"/>'
            )
            y += height
            index += 1
        if footer:
            parts.append(
                f'<text x="{MARGIN}" y="{PAGE_H - MARGIN + 3}" font-size="2.4" fill="{MUTED}">'
                f"{html.escape(footer)}</text>"
            )
        parts.append("</svg>")
        pages.append("".join(parts))
        if not rows:
            break
    return pages


def key_value_page(
    title: str, subtitle: str, sections: list[tuple[str, list[tuple[str, str]]]]
) -> str:
    """A page of labelled sections with key/value lines (cover, summary)."""
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
        f'viewBox="0 0 {PAGE_W} {PAGE_H}" font-family="{FONT}">',
        f'<rect x="0" y="0" width="{PAGE_W}" height="{PAGE_H}" fill="#ffffff"/>',
        f'<text x="{MARGIN}" y="{MARGIN + 6}" font-size="7" font-weight="bold" fill="{LINE}">'
        f"{html.escape(title)}</text>",
        f'<text x="{MARGIN}" y="{MARGIN + 12}" font-size="3.2" fill="{MUTED}">'
        f"{html.escape(subtitle)}</text>",
    ]
    y = MARGIN + 26
    for heading, lines in sections:
        parts.append(
            f'<text x="{MARGIN}" y="{y}" font-size="3.6" font-weight="bold" fill="{LINE}">'
            f"{html.escape(heading)}</text>"
        )
        y += 6
        for key, value in lines:
            parts.append(
                f'<text x="{MARGIN + 2}" y="{y}" font-size="2.8" fill="{MUTED}">'
                f"{html.escape(key)}</text>"
            )
            parts.append(
                f'<text x="{MARGIN + 70}" y="{y}" font-size="2.8" fill="{LINE}">'
                f"{html.escape(str(value))}</text>"
            )
            y += 4.6
        y += 4
        if y > PAGE_H - MARGIN:
            break
    parts.append("</svg>")
    return "".join(parts)
