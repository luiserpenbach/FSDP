"""Engineering analyses: stored calculations with their inputs and results.

Results are always computed on the server by `app.services.analysis` from the
validated inputs, and stored next to them, so a stored analysis can be
reproduced. `POST /analysis/preview` computes without storing.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import record_change, require_model
from app.core.security import require_writer
from app.db import get_db
from app.models import Analysis, Drawing, Project, User
from app.schemas import (
    ANALYSIS_INPUT_MODELS,
    AnalysisCreate,
    AnalysisPreviewIn,
    AnalysisPreviewRead,
    AnalysisRead,
    AnalysisUpdate,
)
from app.services.analysis import AnalysisInputError, run_analysis

analysis_router = APIRouter()


def _validation_message(error: ValidationError) -> str:
    """One readable line per invalid input, e.g. "segments.0.inner_diameter_mm: ..."."""
    parts = []
    for issue in error.errors():
        location = ".".join(str(step) for step in issue["loc"])
        message = issue["msg"].removeprefix("Value error, ")
        parts.append(f"{location}: {message}" if location else message)
    return "; ".join(parts)


def compute(kind: str, raw_inputs: dict) -> tuple[dict, dict]:
    """Validate the inputs of an analysis and compute it: `(inputs, results)`, or 422."""
    model = ANALYSIS_INPUT_MODELS[kind]
    try:
        inputs = model.model_validate(raw_inputs).model_dump()
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=_validation_message(error)) from error
    try:
        return inputs, run_analysis(kind, inputs)
    except AnalysisInputError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _require_project_drawing(db: Session, project_id: str, drawing_id: str | None) -> None:
    if drawing_id is None:
        return
    drawing = require_model(db, Drawing, drawing_id)
    if drawing.project_id != project_id:
        raise HTTPException(status_code=400, detail="Drawing belongs to a different project")


@analysis_router.post("/analysis/preview", response_model=AnalysisPreviewRead)
def preview_analysis(payload: AnalysisPreviewIn) -> dict:
    inputs, results = compute(payload.kind, payload.inputs)
    return {"kind": payload.kind, "inputs": inputs, "results": results}


@analysis_router.get("/projects/{project_id}/analyses", response_model=list[AnalysisRead])
def list_analyses(project_id: str, db: Session = Depends(get_db)) -> list[Analysis]:
    require_model(db, Project, project_id)
    return list(
        db.scalars(
            select(Analysis)
            .where(Analysis.project_id == project_id)
            .order_by(Analysis.created_at.desc(), Analysis.id)
        )
    )


@analysis_router.post(
    "/projects/{project_id}/analyses", response_model=AnalysisRead, status_code=201
)
def create_analysis(
    project_id: str,
    payload: AnalysisCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Analysis:
    require_model(db, Project, project_id)
    _require_project_drawing(db, project_id, payload.drawing_id)
    inputs, results = compute(payload.kind, payload.inputs)
    analysis = Analysis(
        project_id=project_id,
        drawing_id=payload.drawing_id,
        kind=payload.kind,
        name=payload.name,
        inputs=inputs,
        results=results,
        status=payload.status,
        created_by=user.email,
    )
    db.add(analysis)
    db.flush()
    record_change(
        db,
        "analysis",
        analysis.id,
        "created",
        f"Created analysis {analysis.name}",
        actor=user.email,
    )
    db.commit()
    db.refresh(analysis)
    return analysis


@analysis_router.get("/analyses/{analysis_id}", response_model=AnalysisRead)
def get_analysis(analysis_id: str, db: Session = Depends(get_db)) -> Analysis:
    return require_model(db, Analysis, analysis_id)


@analysis_router.put("/analyses/{analysis_id}", response_model=AnalysisRead)
def update_analysis(
    analysis_id: str,
    payload: AnalysisUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Analysis:
    analysis = require_model(db, Analysis, analysis_id)
    changes = payload.model_dump(exclude_unset=True)
    if "drawing_id" in changes:
        _require_project_drawing(db, analysis.project_id, changes["drawing_id"])
        analysis.drawing_id = changes["drawing_id"]
    if changes.get("name") is not None:
        analysis.name = changes["name"]
    if changes.get("status") is not None:
        analysis.status = changes["status"]
    # Always recompute, so the stored results match the stored inputs and the
    # current calculation version.
    source = changes["inputs"] if changes.get("inputs") is not None else analysis.inputs
    analysis.inputs, analysis.results = compute(analysis.kind, source)
    record_change(
        db,
        "analysis",
        analysis.id,
        "updated",
        f"Updated analysis {analysis.name}",
        actor=user.email,
    )
    db.commit()
    db.refresh(analysis)
    return analysis


@analysis_router.delete("/analyses/{analysis_id}", status_code=204)
def delete_analysis(
    analysis_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    analysis = require_model(db, Analysis, analysis_id)
    record_change(
        db,
        "analysis",
        analysis.id,
        "deleted",
        f"Deleted analysis {analysis.name}",
        actor=user.email,
    )
    db.delete(analysis)
    db.commit()
    return Response(status_code=204)
