from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session

from app.models import DrawingSheet, SheetItem, SheetLine, TraceLink


def get_trace_links(db: Session, object_type: str, object_id: str) -> list[TraceLink]:
    return list(
        db.scalars(
            select(TraceLink).where(
                or_(
                    (TraceLink.source_type == object_type) & (TraceLink.source_id == object_id),
                    (TraceLink.target_type == object_type) & (TraceLink.target_id == object_id),
                )
            )
        )
    )


def delete_trace_links_for(db: Session, object_type: str, object_id: str) -> None:
    """Remove every TraceLink that references the given object as source or target."""
    delete_trace_links_for_many(db, [(object_type, object_id)])


def delete_trace_links_for_many(
    db: Session, endpoints: Iterable[tuple[str, str]]
) -> None:
    """Bulk-delete TraceLinks whose source or target matches any (type, id) pair."""
    ids_by_type: dict[str, set[str]] = defaultdict(set)
    for object_type, object_id in endpoints:
        ids_by_type[object_type].add(object_id)
    if not ids_by_type:
        return
    # One IN list per type keeps the statement shallow for large drawings.
    conditions = [
        condition
        for object_type, object_ids in ids_by_type.items()
        for condition in (
            and_(TraceLink.source_type == object_type, TraceLink.source_id.in_(object_ids)),
            and_(TraceLink.target_type == object_type, TraceLink.target_id.in_(object_ids)),
        )
    ]
    db.execute(delete(TraceLink).where(or_(*conditions)))


def sheet_trace_endpoints(db: Session, sheet_ids: Iterable[str]) -> list[tuple[str, str]]:
    """Trace endpoints for every index item and line on the given sheets."""
    ids = list(sheet_ids)
    if not ids:
        return []
    items = db.scalars(select(SheetItem.id).where(SheetItem.sheet_id.in_(ids)))
    lines = db.scalars(select(SheetLine.id).where(SheetLine.sheet_id.in_(ids)))
    return [("sheet_item", item_id) for item_id in items] + [
        ("sheet_line", line_id) for line_id in lines
    ]


def drawing_trace_endpoints(db: Session, drawing_ids: Iterable[str]) -> list[tuple[str, str]]:
    """Trace endpoints for the given drawings and everything on their sheets."""
    ids = list(drawing_ids)
    if not ids:
        return []
    sheet_ids = db.scalars(select(DrawingSheet.id).where(DrawingSheet.drawing_id.in_(ids)))
    return [("drawing", drawing_id) for drawing_id in ids] + sheet_trace_endpoints(db, sheet_ids)
