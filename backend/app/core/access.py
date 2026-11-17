"""Per-project access control.

Rules, in order:

* Administrators can read and change every project.
* An open project (``restricted`` false) behaves as before memberships existed:
  every signed-in user reads it and every engineer changes it.
* A restricted project is visible to its members only. Members with the
  ``viewer`` role read; ``engineer`` and ``owner`` members also change it, if their
  account role allows changes at all. Owners (and administrators) manage the
  member list and the restriction itself.

Routes are guarded in one place: ``enforce_project_access`` is a router-level
dependency that finds the project behind the request's path parameters
(``drawing_id``, ``sheet_id``, ...). Handlers that take a project reference in
the body or return rows of several projects call the helpers here themselves.
A project the user may not see answers 404, like one that does not exist.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import WRITER_ROLES, get_current_user
from app.db import get_db
from app.models import (
    Analysis,
    BomSnapshot,
    ComponentInstance,
    Diagram,
    Drawing,
    DrawingRevision,
    DrawingSheet,
    FluidSystem,
    Hazard,
    LineClass,
    Project,
    ProjectMember,
    Requirement,
    SheetItem,
    SheetLine,
    TraceLink,
    User,
)

MEMBER_ROLES = ("viewer", "engineer", "owner")
MEMBER_WRITE_ROLES = frozenset({"engineer", "owner"})

# Change-event object types that belong to no project (the shared catalog).
GLOBAL_CHANGE_TYPES = frozenset({"part", "parts", "catalog", "catalog_settings", "symbol"})

_NOT_FOUND = HTTPException(status_code=404, detail="Project not found")


def _scalar(db: Session, stmt) -> str | None:
    return db.scalar(stmt)


def _system_project(db: Session, system_id: str) -> str | None:
    return _scalar(db, select(FluidSystem.project_id).where(FluidSystem.id == system_id))


def _drawing_project(db: Session, drawing_id: str) -> str | None:
    return _scalar(db, select(Drawing.project_id).where(Drawing.id == drawing_id))


def _sheet_project(db: Session, sheet_id: str) -> str | None:
    return _scalar(
        db,
        select(Drawing.project_id)
        .join(DrawingSheet, DrawingSheet.drawing_id == Drawing.id)
        .where(DrawingSheet.id == sheet_id),
    )


def _revision_project(db: Session, revision_id: str) -> str | None:
    return _scalar(
        db,
        select(Drawing.project_id)
        .join(DrawingRevision, DrawingRevision.drawing_id == Drawing.id)
        .where(DrawingRevision.id == revision_id),
    )


def _diagram_project(db: Session, diagram_id: str) -> str | None:
    return _scalar(
        db,
        select(FluidSystem.project_id)
        .join(Diagram, Diagram.system_id == FluidSystem.id)
        .where(Diagram.id == diagram_id),
    )


def _snapshot_project(db: Session, snapshot_id: str) -> str | None:
    snapshot = db.execute(
        select(BomSnapshot.drawing_id, BomSnapshot.diagram_id).where(
            BomSnapshot.id == snapshot_id
        )
    ).first()
    if snapshot is None:
        return None
    drawing_id, diagram_id = snapshot
    if drawing_id:
        return _drawing_project(db, drawing_id)
    return _diagram_project(db, diagram_id) if diagram_id else None


def _sheet_item_project(db: Session, row_id: str) -> str | None:
    sheet_id = _scalar(db, select(SheetItem.sheet_id).where(SheetItem.id == row_id))
    return _sheet_project(db, sheet_id) if sheet_id else None


def _sheet_line_project(db: Session, row_id: str) -> str | None:
    sheet_id = _scalar(db, select(SheetLine.sheet_id).where(SheetLine.id == row_id))
    return _sheet_project(db, sheet_id) if sheet_id else None


def _component_project(db: Session, component_id: str) -> str | None:
    diagram_id = _scalar(
        db, select(ComponentInstance.diagram_id).where(ComponentInstance.id == component_id)
    )
    return _diagram_project(db, diagram_id) if diagram_id else None


# Project of an object, by the type names trace links and change impact use.
OBJECT_PROJECT_RESOLVERS: dict[str, Callable[[Session, str], str | None]] = {
    "project": lambda db, object_id: _scalar(
        db, select(Project.id).where(Project.id == object_id)
    ),
    "fluid_system": _system_project,
    "drawing": _drawing_project,
    "sheet": _sheet_project,
    "sheet_item": _sheet_item_project,
    "sheet_line": _sheet_line_project,
    "requirement": lambda db, object_id: _scalar(
        db, select(Requirement.project_id).where(Requirement.id == object_id)
    ),
    "diagram": _diagram_project,
    "component": _component_project,
    "hazard": lambda db, object_id: _scalar(
        db, select(Hazard.project_id).where(Hazard.id == object_id)
    ),
    "analysis": lambda db, object_id: _scalar(
        db, select(Analysis.project_id).where(Analysis.id == object_id)
    ),
    "bom_snapshot": _snapshot_project,
}


def object_project_id(db: Session, object_type: str, object_id: str) -> str | None:
    """Project an object belongs to; None for catalog objects and unknown ones."""
    resolver = OBJECT_PROJECT_RESOLVERS.get(object_type)
    return resolver(db, object_id) if resolver else None


def _link_projects(db: Session, link_id: str) -> list[str]:
    link = db.get(TraceLink, link_id)
    if link is None:
        return []
    found = {
        object_project_id(db, link.source_type, link.source_id),
        object_project_id(db, link.target_type, link.target_id),
    }
    return [project_id for project_id in found if project_id]


# Path parameter name -> projects the request touches.
PATH_RESOLVERS: dict[str, Callable[[Session, str], list[str]]] = {
    "link_id": _link_projects,
}
for _name, _type in (
    ("project_id", "project"),
    ("system_id", "fluid_system"),
    ("drawing_id", "drawing"),
    ("sheet_id", "sheet"),
    ("requirement_id", "requirement"),
    ("diagram_id", "diagram"),
    ("snapshot_id", "bom_snapshot"),
    ("hazard_id", "hazard"),
    ("analysis_id", "analysis"),
):
    PATH_RESOLVERS[_name] = (
        lambda db, object_id, _type=_type: [
            project_id
            for project_id in [object_project_id(db, _type, object_id)]
            if project_id
        ]
    )
PATH_RESOLVERS["revision_id"] = lambda db, object_id: [
    project_id for project_id in [_revision_project(db, object_id)] if project_id
]
PATH_RESOLVERS["line_class_id"] = lambda db, object_id: [
    project_id
    for project_id in [
        _scalar(db, select(LineClass.project_id).where(LineClass.id == object_id))
    ]
    if project_id
]


def register_path_resolver(
    param: str, project_of: Callable[[Session, str], str | None]
) -> None:
    """Guard routes of a new project-owned object type by its path parameter name."""
    PATH_RESOLVERS[param] = lambda db, object_id: [
        project_id for project_id in [project_of(db, object_id)] if project_id
    ]


# POST routes that only read (a viewer may call them).
# copy_drawing reads its source; the handler checks the destination itself.
READ_ONLY_ROUTES = frozenset({"export_sheet", "copy_drawing"})


def member_role(db: Session, project_id: str, user: User) -> str | None:
    return db.scalar(
        select(ProjectMember.role).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user.id
        )
    )


def hidden_project_ids(db: Session, user: User) -> set[str]:
    """Restricted projects this user is not a member of (empty for administrators)."""
    if user.role == "admin":
        return set()
    mine = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    return set(
        db.scalars(
            select(Project.id).where(Project.restricted.is_(True), Project.id.notin_(mine))
        )
    )


def can_read_project(db: Session, user: User, project: Project) -> bool:
    if user.role == "admin" or not project.restricted:
        return True
    return member_role(db, project.id, user) is not None


def can_write_project(db: Session, user: User, project: Project) -> bool:
    if user.role == "admin":
        return True
    if user.role not in WRITER_ROLES:
        return False
    if not project.restricted:
        return True
    return member_role(db, project.id, user) in MEMBER_WRITE_ROLES


def can_manage_project(db: Session, user: User, project: Project) -> bool:
    """Who may change the member list and the restriction."""
    if user.role == "admin":
        return True
    return user.role in WRITER_ROLES and member_role(db, project.id, user) == "owner"


def require_project_read(db: Session, user: User, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None or not can_read_project(db, user, project):
        raise _NOT_FOUND
    return project


def require_project_write(db: Session, user: User, project_id: str) -> Project:
    project = require_project_read(db, user, project_id)
    if not can_write_project(db, user, project):
        raise HTTPException(
            status_code=403,
            detail=f"You have read-only access to project {project.name}.",
        )
    return project


def require_object_read(db: Session, user: User, object_type: str, object_id: str) -> None:
    project_id = object_project_id(db, object_type, object_id)
    if project_id:
        require_project_read(db, user, project_id)


def require_object_write(db: Session, user: User, object_type: str, object_id: str) -> None:
    project_id = object_project_id(db, object_type, object_id)
    if project_id:
        require_project_write(db, user, project_id)


def enforce_project_access(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Check the request against the project(s) its path parameters point at."""
    project_ids: list[str] = []
    for name, value in request.path_params.items():
        resolver = PATH_RESOLVERS.get(name)
        if resolver is not None:
            project_ids.extend(resolver(db, str(value)))
    if not project_ids:
        return
    route = request.scope.get("route")
    read_only = request.method in ("GET", "HEAD", "OPTIONS") or (
        getattr(route, "name", None) in READ_ONLY_ROUTES
    )
    for project_id in dict.fromkeys(project_ids):
        if read_only:
            require_project_read(db, user, project_id)
        else:
            require_project_write(db, user, project_id)
    # Stamped onto change events recorded while handling this request.
    db.info["project_id"] = project_ids[0]
