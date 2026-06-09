from sqlalchemy import or_, select
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
