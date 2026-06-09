from app.models import Part


def qualification_warnings(part: Part) -> list[str]:
    warnings: list[str] = []
    if part.qualification_status not in {"qualified", "preferred"}:
        warnings.append("Part is not qualified or preferred.")
    if part.pressure_rating_bar is None:
        warnings.append("Pressure rating is missing.")
    if part.material is None:
        warnings.append("Material is missing.")
    return warnings
