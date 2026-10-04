"""XLSX export of a table exactly as the UI shows it.

The DataGrid (parts catalog, requirements, verification matrix, ...) sends its
visible columns and its filtered, sorted rows; this returns them as a workbook
built by the same writer as the drawing lists (`rows_to_xlsx`), so every export
gets the title block, frozen header and formula-injection guard.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Response
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from pydantic import BaseModel, Field

from app.services.lists import rows_to_xlsx

export_router = APIRouter()

MAX_EXPORT_ROWS = 20_000
MAX_EXPORT_COLUMNS = 100
# Excel refuses longer cell text.
MAX_CELL_CHARS = 32_767
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

CellValue = bool | int | float | str | None


class ExportColumn(BaseModel):
    key: str = Field(min_length=1, max_length=100)
    header: str = Field(max_length=200)


class TableExportIn(BaseModel):
    title: str = Field(default="Export", max_length=100)
    file_name: str = Field(default="export", max_length=100)
    columns: list[ExportColumn] = Field(min_length=1, max_length=MAX_EXPORT_COLUMNS)
    rows: list[dict[str, CellValue]] = Field(max_length=MAX_EXPORT_ROWS)


def _clean_cell(value: CellValue) -> CellValue:
    if isinstance(value, str):
        # Control characters make openpyxl refuse the whole workbook.
        return ILLEGAL_CHARACTERS_RE.sub("", value)[:MAX_CELL_CHARS]
    if isinstance(value, float) and value != value:  # NaN
        return None
    return value


def _sheet_title(title: str) -> str:
    # Sheet names may not contain []:*?/\ and are at most 31 characters (rows_to_xlsx cuts).
    cleaned = re.sub(r"[\[\]:*?/\\]+", " ", ILLEGAL_CHARACTERS_RE.sub("", title))
    return " ".join(cleaned.split()) or "Export"


def _file_name(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.") or "export"
    return slug if slug.lower().endswith(".xlsx") else f"{slug}.xlsx"


@export_router.post(
    "/exports/xlsx",
    response_class=Response,
    responses={200: {"content": {XLSX_MEDIA_TYPE: {}}, "description": "The table as XLSX"}},
)
def export_table_xlsx(payload: TableExportIn) -> Response:
    """Turn the rows and columns a table shows into an XLSX download."""
    columns = [(f"c{index}", column.header) for index, column in enumerate(payload.columns)]
    rows = [
        {
            f"c{index}": _clean_cell(row.get(column.key))
            for index, column in enumerate(payload.columns)
        }
        for row in payload.rows
    ]
    header = {
        "list": _sheet_title(payload.title),
        "exported": datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        "rows": len(rows),
    }
    content = rows_to_xlsx(header, columns, rows)
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{_file_name(payload.file_name)}"'},
    )
