# FSDP Implementation Guide

## Repository Structure

```text
FSDP/
  backend/
    alembic/                 Database migrations
    app/
      api/routes.py          FastAPI route handlers
      core/config.py         Runtime settings
      db.py                  SQLAlchemy engine/session dependency
      main.py                FastAPI app entry point
      models.py              SQLAlchemy domain model
      schemas.py             Pydantic request/response schemas
      services/              BoM, traceability, catalog, and impact services
    tests/                   Backend unit and API workflow tests
  frontend/
    src/
      App.tsx                MVP workspace UI
      api.ts                 Frontend API client
      types.ts               Frontend domain types
      styles.css             Application styles
  docs/
    architecture.md          Architecture overview
    implementation.md        Current implementation guide
    requirements.md          Product requirements and MVP scope
  infra/
    README.md                Infrastructure notes
  docker-compose.yml         Local PostgreSQL service
  README.md                  Project entry point and local setup
```

## Runtime Architecture

FSDP is currently implemented as a split web application:

- Backend: FastAPI, SQLAlchemy, Alembic, PostgreSQL.
- Frontend: React, TypeScript, Vite, React Flow.
- Local infrastructure: Docker Compose for PostgreSQL.

```mermaid
flowchart LR
  Browser[Browser] --> Frontend[React Vite App]
  Frontend --> ApiClient[API Client]
  ApiClient --> Backend[FastAPI]
  Backend --> Services[Domain Services]
  Services --> Database[(PostgreSQL)]
  Backend --> OpenApi[OpenAPI Docs]
```

The backend owns all persisted domain objects and business rules. The frontend currently provides a single MVP workspace that exercises the connected design workflow.

## Backend

### Entry Points

- `backend/app/main.py` creates the FastAPI app, configures CORS, registers routes, and exposes `/health`.
- `backend/app/api/routes.py` contains the current REST API.
- `backend/app/db.py` provides SQLAlchemy session management through FastAPI dependency injection.
- `backend/app/core/config.py` reads settings from environment variables with the `FSDP_` prefix.

Default database URL:

```text
postgresql+psycopg://fsdp:fsdp@localhost:5432/fsdp
```

Override with:

```powershell
$env:FSDP_DATABASE_URL = "postgresql+psycopg://user:password@host:5432/database"
```

### Data Model

The current relational model is defined in `backend/app/models.py`.

Core tables:

- `projects`: top-level engineering project.
- `fluid_systems`: project-owned fluid systems.
- `diagrams`: saved P&ID graph documents with revision and graph JSON.
- `diagram_nodes`: normalized graph nodes for queryable diagram structure.
- `diagram_edges`: normalized graph edges and line-like attributes.
- `parts`: internal or vendor catalog parts.
- `component_instances`: part usage on a diagram, optionally bound to a persisted diagram node.
- `requirements`: project-level requirements.
- `trace_links`: typed links between requirements, components, and other object types.
- `bom_snapshots`: generated BoM rows for a diagram at a point in time.
- `change_events`: simple audit/change records used by change impact views.

Important modeling choices:

- `Diagram.graph` stores the full React Flow payload for round-tripping the editor state.
- `DiagramNode` and `DiagramEdge` store normalized graph data for BoM, traceability, and later analysis.
- `ComponentInstance.node_id` binds a placed component to an actual `DiagramNode`.
- `Part.metadata_` maps to the database column named `metadata` to avoid colliding with SQLAlchemy's reserved `metadata` attribute.

### Services

Service modules live in `backend/app/services/`.

- `bom.py`: rolls component instances up into BoM snapshot rows.
- `traceability.py`: returns trace links for an object in either source or target direction.
- `change_impact.py`: identifies linked objects, affected components, and affected BoM snapshots.
- `catalog.py`: contains early catalog-quality warnings for missing qualification data.

### API Summary

The backend exposes OpenAPI documentation at:

```text
http://localhost:8000/docs
```

Implemented endpoint groups:

Projects:

- `POST /projects`
- `GET /projects`
- `GET /projects/{project_id}`
- `PUT /projects/{project_id}`
- `DELETE /projects/{project_id}`

Fluid systems:

- `POST /projects/{project_id}/systems`
- `GET /projects/{project_id}/systems`
- `PUT /systems/{system_id}`
- `DELETE /systems/{system_id}`

Diagrams:

- `POST /systems/{system_id}/diagrams`
- `GET /systems/{system_id}/diagrams`
- `GET /diagrams/{diagram_id}`
- `PUT /diagrams/{diagram_id}`
- `DELETE /diagrams/{diagram_id}`
- `PUT /diagrams/{diagram_id}/graph`

Parts:

- `POST /parts`
- `GET /parts`
- `GET /parts/{part_id}`
- `PUT /parts/{part_id}`
- `DELETE /parts/{part_id}`

Components:

- `POST /diagrams/{diagram_id}/components`
- `GET /diagrams/{diagram_id}/components`
- `PUT /components/{component_id}`
- `DELETE /components/{component_id}`

Requirements:

- `POST /requirements`
- `GET /projects/{project_id}/requirements`
- `PUT /requirements/{requirement_id}`
- `DELETE /requirements/{requirement_id}`

Traceability:

- `POST /trace-links`
- `GET /objects/{object_type}/{object_id}/trace`

BoM:

- `POST /diagrams/{diagram_id}/bom`
- `GET /diagrams/{diagram_id}/bom`
- `GET /projects/{project_id}/bom`
- `GET /bom/{snapshot_id}/csv`

Change impact:

- `GET /changes/impact?object_type=...&object_id=...`

### Validation and Error Handling

Current explicit validations:

- Duplicate project names return `409`.
- Duplicate part numbers return `409`.
- Duplicate requirement keys within a project return `409`.
- Component placement validates that the selected graph node exists in the target diagram.
- Component updates validate that selected nodes belong to the component's diagram.

Future validation should add stronger field constraints, engineering-unit validation, and object-type validation for trace links.

## Frontend

### Entry Points

- `frontend/src/main.tsx` mounts the React app and imports React Flow styles.
- `frontend/src/App.tsx` contains the current MVP workspace.
- `frontend/src/api.ts` wraps backend HTTP calls.
- `frontend/src/types.ts` defines frontend data types aligned with backend responses.
- `frontend/src/styles.css` contains layout and interaction styling.

### MVP Workspace Flow

The current page supports this workflow:

1. Create, select, update, or delete a project.
2. Create, select, update, or delete a fluid system under the active project.
3. Create, open, rename, delete, edit, and save a P&ID diagram graph.
4. Add graph nodes and lines with React Flow.
5. Create, select, update, or delete catalog parts.
6. Place a selected part onto a selected diagram node as a component instance.
7. Create, select, update, or delete requirements.
8. Link a selected requirement to a selected component.
9. Generate BoM snapshots and download CSV.
10. Inspect basic change impact for the selected component or part.

### Diagram Persistence

React Flow nodes and edges are saved through:

```text
PUT /diagrams/{diagram_id}/graph
```

The backend stores:

- `Diagram.graph`: full editor payload used to restore the React Flow canvas.
- `DiagramNode`: normalized nodes.
- `DiagramEdge`: normalized edges.

When a user selects an existing diagram in the frontend, the app fetches the diagram and restores `graph.nodes` and `graph.edges` into React Flow state.

### Component Placement

The frontend sends `properties.node_external_id` when placing a part on a graph node. The backend resolves that external graph id to the persisted `DiagramNode.id` and stores it in `ComponentInstance.node_id`.

This means placed components are tied to queryable diagram nodes, not only to frontend-only graph ids.

## Local Development

Start PostgreSQL:

```powershell
docker compose up -d db
```

Run backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

Run frontend:

```powershell
cd frontend
npm install
npm run dev
```

Default URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`
- Backend OpenAPI: `http://localhost:8000/docs`

## Verification

Backend:

```powershell
cd backend
python -m pytest
python -m ruff check .
```

Frontend:

```powershell
cd frontend
npm test
npm run build
```

Current backend tests cover:

- BoM rollup.
- Traceability lookup.
- Change impact lookup.
- Catalog warnings.
- End-to-end API workflow for project/system/diagram/part/component/BoM.
- Duplicate validation and delete flow.

## Current Limitations

- The frontend is still a single-page MVP workspace, not a production navigation model.
- There is no authentication, authorization, or role-based approval workflow.
- Change impact is shallow and only follows direct trace links plus part/component BoM usage.
- Diagram symbols are generic React Flow nodes, not a full P&ID symbol library.
- Engineering analysis modules are not implemented yet.
- Configuration baselines, branches, and releases are not implemented yet.
- Certification package generation is not implemented beyond BoM CSV export and future-oriented stubs.

## Recommended Next Implementation Areas

1. Add pressure-drop analysis for simple incompressible line networks.
2. Introduce hazard objects linked to components, lines, and requirements.
3. Add trapped-volume detection from valve states and graph connectivity.
4. Add relief valve sizing with stored assumptions and calculation reports.
5. Add verification matrix views from requirements and trace links.
6. Add release/baseline snapshots for diagrams, BoMs, requirements, and analyses.
