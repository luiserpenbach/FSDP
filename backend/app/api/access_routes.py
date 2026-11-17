"""Project access: the restriction flag and the member list."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import record_change, require_model
from app.core.access import (
    can_manage_project,
    can_write_project,
    require_project_read,
)
from app.core.security import get_current_user, require_writer
from app.db import get_db
from app.models import Project, ProjectMember, User
from app.schemas import (
    ProjectAccessRead,
    ProjectAccessUpdate,
    ProjectMemberIn,
    UserDirectoryEntry,
)

access_router = APIRouter()


def _access(db: Session, user: User, project: Project) -> dict:
    rows = db.execute(
        select(ProjectMember, User)
        .join(User, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project.id)
        .order_by(User.name)
    ).all()
    return {
        "project_id": project.id,
        "restricted": project.restricted,
        "members": [
            {
                "user_id": account.id,
                "email": account.email,
                "name": account.name,
                "role": member.role,
                "account_role": account.role,
                "is_active": account.is_active,
            }
            for member, account in rows
        ],
        "can_manage": can_manage_project(db, user, project),
        "can_write": can_write_project(db, user, project),
    }


def _manageable(db: Session, user: User, project_id: str) -> Project:
    project = require_project_read(db, user, project_id)
    if not can_manage_project(db, user, project):
        raise HTTPException(
            status_code=403,
            detail="Only an owner of the project or an administrator can change its access.",
        )
    return project


def _owner_count(db: Session, project_id: str) -> int:
    return len(
        list(
            db.scalars(
                select(ProjectMember.id).where(
                    ProjectMember.project_id == project_id, ProjectMember.role == "owner"
                )
            )
        )
    )


@access_router.get("/projects/{project_id}/access", response_model=ProjectAccessRead)
def get_project_access(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return _access(db, user, require_model(db, Project, project_id))


@access_router.put("/projects/{project_id}/access", response_model=ProjectAccessRead)
def update_project_access(
    project_id: str,
    payload: ProjectAccessUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    project = _manageable(db, user, project_id)
    if payload.restricted != project.restricted:
        project.restricted = payload.restricted
        state = "members only" if payload.restricted else "open to all users"
        record_change(
            db,
            "project",
            project.id,
            "access_changed",
            f"Made project {project.name} {state}",
            actor=user.email,
        )
        db.commit()
    return _access(db, user, project)


@access_router.put(
    "/projects/{project_id}/members/{user_id}", response_model=ProjectAccessRead
)
def set_project_member(
    project_id: str,
    user_id: str,
    payload: ProjectMemberIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Add a member or change a member's role."""
    project = _manageable(db, user, project_id)
    account = db.get(User, user_id)
    if account is None:
        raise HTTPException(status_code=404, detail="User not found")
    member = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id, ProjectMember.user_id == user_id
        )
    )
    if member is None:
        db.add(ProjectMember(project_id=project.id, user_id=user_id, role=payload.role))
        summary = f"Added {account.email} to project {project.name} as {payload.role}"
    else:
        if (
            member.role == "owner"
            and payload.role != "owner"
            and project.restricted
            and _owner_count(db, project.id) <= 1
        ):
            raise HTTPException(
                status_code=400, detail="A members-only project needs at least one owner."
            )
        member.role = payload.role
        summary = f"Made {account.email} {payload.role} of project {project.name}"
    record_change(db, "project", project.id, "access_changed", summary, actor=user.email)
    db.commit()
    return _access(db, user, project)


@access_router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def remove_project_member(
    project_id: str,
    user_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    project = _manageable(db, user, project_id)
    member = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id, ProjectMember.user_id == user_id
        )
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    if member.role == "owner" and project.restricted and _owner_count(db, project.id) <= 1:
        raise HTTPException(
            status_code=400, detail="A members-only project needs at least one owner."
        )
    account = db.get(User, user_id)
    record_change(
        db,
        "project",
        project.id,
        "access_changed",
        f"Removed {account.email if account else user_id} from project {project.name}",
        actor=user.email,
    )
    db.delete(member)
    db.commit()
    return Response(status_code=204)


@access_router.get("/users/directory", response_model=list[UserDirectoryEntry])
def user_directory(
    db: Session = Depends(get_db), _user: User = Depends(require_writer)
) -> list[User]:
    """Active accounts, for picking project members (writers only)."""
    return list(db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.name)))
