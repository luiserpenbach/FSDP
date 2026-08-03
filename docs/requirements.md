# FSDP Product Requirements

## Product Vision

The Fluid Systems Development Platform (FSDP) is intended to provide a single engineering environment where fluid systems are defined, analyzed, reviewed, procured, built, tested, and certified through a connected digital thread.

The platform should replace disconnected spreadsheets, drawings, analysis reports, parts databases, and certification documents with a unified system model.

Target domains include propulsion systems, launch vehicles, spacecraft, test stands, and ground support equipment.

## Product Goals

Primary goals:

- Reduce fluid system design cycle time.
- Eliminate duplicated engineering data across drawings, spreadsheets, analyses, BoMs, and certification artifacts.
- Increase reuse of qualified designs, standard parts, and vendor parts.
- Improve safety review completeness and traceability.
- Generate procurement and certification artifacts from connected engineering data.

Success metrics from the initial PRD:

- Generate a BoM in less than 5 minutes.
- Perform change impact analysis in less than 1 minute.
- Increase design reuse rate by 40%.
- Reduce safety review preparation time by 60%.
- Achieve 100% requirements traceability coverage.
- Reduce engineering data consistency violations by 80%.

## Primary Users

### Propulsion Engineer

Designs fluid systems and performs engineering analysis.

Needs:

- Rapid architecture creation.
- Component and standard-part selection.
- PFD and P&ID authoring.
- Flow, pressure-drop, relief, trapped-volume, and compatibility analysis.
- Safety assessment and design-rule checks.

### Systems Engineer

Owns requirements, verification, and system-level traceability.

Needs:

- Requirements database.
- Requirement-to-hardware and requirement-to-analysis links.
- Verification matrix.
- Certification evidence.
- Change impact visibility.

### Responsible Engineer

Owns subsystem approval and technical signoff.

Needs:

- Review workflows.
- Configuration control.
- Design signoff.
- Risk and change visibility.

### Manufacturing Engineer

Turns engineering definition into build documentation and as-built records.

Needs:

- Assembly instructions.
- Weld maps.
- Torque and inspection requirements.
- Installed serial numbers.
- Test and inspection records.
- NCR traceability.

### Supply Chain and Procurement

Procures hardware and manages vendor constraints.

Needs:

- Approved BoMs.
- Vendor qualification status.
- Lead-time visibility.
- Cost rollups.
- Alternate part recommendations.

### Safety and Mission Assurance

Reviews hazards, failure modes, and compliance evidence.

Needs:

- Hazard tracking.
- FMEA and FHA support.
- Relief analysis.
- Trapped-volume and overpressure checks.
- Compliance evidence.

## Core Engineering Object Types

The long-term product model is based on connected, version-controlled engineering objects:

- `FluidSystem`
- `Subsystem`
- `Line`
- `Component`
- `Requirement`
- `Hazard`
- `Analysis`
- `Test`
- `VendorPart`
- `InternalPart`
- `BuildConfiguration`
- `CertificationArtifact`

The MVP implements a smaller subset while keeping the model extensible.

## Product Epics

### Epic 1: System Design Environment

Goal: enable engineers to create fluid system architectures.

Includes:

- PFD authoring.
- P&ID authoring.
- Fluid streams, flow direction, operating modes, state points, and subsystem boundaries.
- Hardware symbols for valves, regulators, relief devices, sensors, filters, fittings, hoses, and welds.
- Auto-tagging and line-number generation.
- Diagram export.
- Operating modes such as fill, drain, purge, chilldown, pressurization, flight, and safe mode.

### Epic 2: Engineering Data Model

Goal: create a single source of truth.

Includes:

- Component objects with part number, description, manufacturer, material, pressure rating, temperature range, Cv, mass, dimensions, and certification status.
- Line objects with fluid, pressure, temperature, diameter, material, cleanliness, insulation, and trace heating.
- Configuration control with revisions, branches, baselines, and releases.

### Epic 3: Parts and Vendor Management

Goal: provide a centralized engineering parts catalog.

Includes:

- Internal standard parts.
- Qualified, preferred, legacy, and restricted parts.
- Vendor catalog data.
- Datasheets, CAD, test reports, certificates, and CoCs.
- Alternate part recommendations based on pressure rating, envelope, material compatibility, lead time, and cost.

### Epic 4: Fluid Analysis Suite

Goal: perform first-order engineering analysis inside the platform.

Includes:

- Pressure-drop analysis.
- Valve sizing.
- Relief valve sizing for blocked outlet, regulator failure, thermal expansion, and external heat load scenarios.
- Trapped-volume detection.
- Fluid compatibility checks.

### Epic 5: Requirements Management

Goal: connect requirements directly to hardware, analyses, tests, and hazards.

Includes:

- Functional, performance, safety, manufacturing, and verification requirements.
- Trace links between requirements, components, analyses, tests, and hazards.
- Auto-generated verification matrix with method, owner, status, and evidence.

### Epic 6: Safety and Mission Assurance

Goal: reduce manual safety review effort.

Includes:

- Hazard tracking for overpressure, backflow, ignition, contamination, single-point failure, and trapped fluid.
- FMEA.
- Fault tree analysis.
- Design-rule checks for unprotected pressure sources, missing relief devices, dead-end lines, and improper isolation.

### Epic 7: BoM and Procurement

Goal: generate procurement-ready hardware packages.

Includes:

- Auto-BoM generation from P&ID and assembly hierarchy.
- Procurement readiness checks for missing specifications, unapproved parts, obsolete parts, and long-lead items.
- Cost and schedule analytics.

### Epic 8: Manufacturing and Test

Goal: connect engineering definition to build and validation.

Includes:

- Assembly instructions.
- Weld maps.
- Torque requirements.
- Inspection points.
- Leak test, proof test, and flow characterization procedures.
- As-built serials, test results, inspections, and NCRs.

### Epic 9: Certification and Compliance

Goal: produce certification evidence automatically.

Includes:

- Design descriptions.
- Requirements matrices.
- Analysis reports.
- Test evidence.
- Certification dashboard for open items, missing evidence, and pending approvals.

### Epic 10: Collaboration and Reviews

Goal: enable structured engineering reviews.

Includes:

- SRR, PDR, CDR, test readiness, and flight readiness reviews.
- Change impact analysis across parts, analyses, requirements, hazards, and tests.
- Approval workflows for engineer, reviewer, responsible engineer, safety, and manufacturing roles.

### Epic 11: Search and Reuse

Goal: leverage organizational knowledge.

Includes:

- Global search by fluid, pressure, part number, hazard, requirement, and qualification status.
- Reusable subsystem templates for helium pressurization, methane feed, LOX feed, GN2 purge, pneumatic actuation, and test stand fill/drain.

### Epic 12: Digital Thread Platform

Goal: create full lifecycle traceability.

Includes:

- Vehicle configuration tracking from vehicle to subsystem to part to serial number.
- Operational data integration for ground test data, acceptance testing, flight telemetry, and failure investigations.

## MVP Scope

The first release focuses on the highest-value workflow:

- P&ID editor.
- Component database.
- Requirements management.
- Auto-generated BoMs.
- Basic traceability.
- Basic change impact analysis.
- Certification package export stubs.

The original PRD also included pressure-drop analysis, relief valve sizing, trapped-volume analysis, and hazard tracking in the MVP. The current implementation intentionally establishes the digital-thread foundation first, so these analysis and safety modules can be added as traceable backend services.

## Deferred Scope

Deferred from the first implementation:

- Full transient simulation.
- Digital twin integration.
- ERP integration.
- Advanced FTA automation.
- AI recommendations.
- Full enterprise approval workflows.
- Full configuration branching and baselining.
- CAD and datasheet ingestion beyond basic metadata.

## Current Implementation Coverage

Implemented as of the current MVP:

- User accounts with sign-in, roles (admin/engineer/viewer), and an actor-stamped change history.
- Project creation, selection, update, and delete.
- Fluid system creation, selection, update, and delete.
- P&ID diagram creation, listing, reopening, renaming, deletion, and saved graph restoration.
- React Flow graph editing with saved nodes and edges.
- Component catalog creation, selection, update, and delete.
- Component placement on persisted diagram nodes.
- Requirement creation, selection, update, and delete.
- Requirement-to-component trace links.
- BoM snapshot generation and CSV export.
- Diagram-level and project-level BoM history endpoints.
- Basic change impact for parts and components.

Not yet implemented:

- Pressure-drop calculation.
- Relief valve sizing.
- Trapped-volume detection.
- Hazard objects and hazard reports.
- Verification matrix UI.
- Certification package generation beyond export stubs.
- Per-role write restrictions and review/approval workflows.
