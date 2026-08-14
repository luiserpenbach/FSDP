from collections.abc import Iterable

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session

from app.models import TraceLink


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
    pairs = list(endpoints)
    if not pairs:
        return
    conditions = [
        and_(TraceLink.source_type == object_type, TraceLink.source_id == object_id)
        for object_type, object_id in pairs
    ] + [
        and_(TraceLink.target_type == object_type, TraceLink.target_id == object_id)
        for object_type, object_id in pairs
    ]
    db.execute(delete(TraceLink).where(or_(*conditions)))
