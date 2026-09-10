"""Sheet export: convert the shared renderer's SVG into PDF or PNG.

The browser renders the sheet with the engine renderer (the same code that
draws the canvas) and sends the SVG here; Cairo turns it into a vector PDF at
paper size or a PNG at the requested DPI. Keeping the conversion server-side
gives every client identical output and a place to store release artifacts.
"""

from __future__ import annotations

import re

import cairosvg

_SCRIPT_TAG = re.compile(r"<\s*script[^>]*>.*?<\s*/\s*script\s*>", re.IGNORECASE | re.DOTALL)
_EXTERNAL_REF = re.compile(r"""(href|src)\s*=\s*['"](?:https?:|file:|ftp:)""", re.IGNORECASE)


def sanitize_svg(svg: str) -> str:
    """Strip scripts and refuse external references before handing SVG to Cairo."""
    cleaned = _SCRIPT_TAG.sub("", svg)
    if _EXTERNAL_REF.search(cleaned):
        raise ValueError("SVG must not reference external resources")
    return cleaned


def svg_to_pdf(svg: str) -> bytes:
    return cairosvg.svg2pdf(bytestring=sanitize_svg(svg).encode("utf-8"))


def svg_to_png(svg: str, dpi: int = 300) -> bytes:
    return cairosvg.svg2png(bytestring=sanitize_svg(svg).encode("utf-8"), dpi=dpi)


def export_filename(number: str, sheet_no: int, revision_label: str, fmt: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", number).strip("-") or "drawing"
    rev = re.sub(r"[^A-Za-z0-9]+", "", revision_label) or "0"
    return f"{safe}-{sheet_no:02d}-rev{rev}.{fmt}"
