"""Engineering calculators: line pressure drop and relief valve sizing.

Every function here is pure (no database, no I/O) so a stored analysis can be
recomputed from its inputs and must give the same result. `CALC_VERSION` is
stored with each result; bump it whenever a formula, constant, or default
changes so old results can be told apart from new ones.

Scope and limits (also returned to the user as assumptions and warnings):

* Pressure drop: steady, single-phase, incompressible (liquid) flow through
  line segments in series. No networks, no compressible gas flow, no
  cavitation or flashing check.
* Relief sizing: API Standard 520 Part I preliminary sizing in SI units for
  gas or vapour (critical and subcritical flow) and for liquids in valves
  that require capacity certification. Steam, two-phase flow, fire-case heat
  input, and inlet/outlet line losses are not covered. The result is an
  API "effective" area for selecting an API 526 orifice letter; the final
  selection must be confirmed with the manufacturer's certified capacity.

Input validation of single fields (ranges, required values) lives in
`app.schemas`; this module raises `AnalysisInputError` for combinations that
make the physics undefined.
"""

from __future__ import annotations

import math

CALC_VERSION = 1

# Standard gravity, m/s^2 (exact by definition).
G0 = 9.80665
# Reference water density for specific gravity, kg/m^3 (water at 15.6 degC / 60 degF).
WATER_REFERENCE_DENSITY = 999.0
# US liquid gallon in m^3 and pound-force per square inch in Pa (both exact).
US_GALLON_M3 = 3.785411784e-3
PSI_PA = 6894.757293168
STANDARD_ATMOSPHERE_KPA = 101.325

# Flow regime limits on the pipe Reynolds number.
RE_LAMINAR_MAX = 2300.0
RE_TURBULENT_MIN = 4000.0
# Published validity of the Swamee-Jain correlation.
SWAMEE_JAIN_RE_RANGE = (5.0e3, 1.0e8)
SWAMEE_JAIN_ROUGHNESS_RANGE = (1.0e-6, 1.0e-2)

DEFAULT_VELOCITY_LIMIT_M_S = 3.0


class AnalysisInputError(ValueError):
    """Inputs are individually valid but the calculation is undefined for them."""


# --------------------------------------------------------------------------
# Pressure drop
# --------------------------------------------------------------------------


def swamee_jain_friction_factor(reynolds: float, relative_roughness: float) -> float:
    """Darcy friction factor from the explicit Swamee-Jain correlation.

    f = 0.25 / [log10(eps/(3.7 D) + 5.74 / Re^0.9)]^2

    `relative_roughness` is eps/D (dimensionless). Published validity:
    5e3 <= Re <= 1e8 and 1e-6 <= eps/D <= 1e-2, where it stays within about
    1 % to 3 % of the Colebrook-White equation. For a hydraulically smooth
    pipe (eps = 0) the roughness term vanishes and the formula still applies.
    """
    if reynolds <= 0:
        raise AnalysisInputError("Reynolds number must be positive.")
    term = relative_roughness / 3.7 + 5.74 / reynolds**0.9
    return 0.25 / math.log10(term) ** 2


def friction_factor(reynolds: float, relative_roughness: float) -> tuple[float, str]:
    """Darcy friction factor and flow regime for a round pipe.

    * Re < 2300: laminar, f = 64 / Re (Hagen-Poiseuille).
    * Re >= 4000: turbulent, Swamee-Jain.
    * 2300 <= Re < 4000: transitional. The real factor is unpredictable
      here; the larger of the laminar and Swamee-Jain values is returned so
      the pressure drop is not under-estimated.

    Returns `(f, regime)` with regime one of "laminar", "transitional",
    "turbulent".
    """
    if reynolds <= 0:
        raise AnalysisInputError("Reynolds number must be positive.")
    if reynolds < RE_LAMINAR_MAX:
        return 64.0 / reynolds, "laminar"
    turbulent = swamee_jain_friction_factor(reynolds, relative_roughness)
    if reynolds < RE_TURBULENT_MIN:
        return max(64.0 / reynolds, turbulent), "transitional"
    return turbulent, "turbulent"


def cv_pressure_drop_pa(volumetric_flow_m3_s: float, cv: float, density_kg_m3: float) -> float:
    """Pressure drop in Pa across a valve or component given its flow coefficient Cv.

    Cv convention (US customary, ANSI/ISA-75.01 / IEC 60534 basic liquid
    equation): Cv is the flow of water at 60 degF in US gallons per minute
    that passes with a pressure drop of 1 psi:

        Q[US gpm] = Cv * sqrt(dP[psi] / SG),  so  dP[psi] = SG * (Q[US gpm] / Cv)^2

    with SG = density / 999.0 kg/m^3. This is NOT the metric Kv
    (m^3/h at 1 bar); convert with Cv = 1.156 * Kv before entering a Kv
    value. Valid for turbulent, non-choked, non-cavitating liquid flow.
    """
    if cv <= 0:
        raise AnalysisInputError("Cv must be greater than zero.")
    flow_gpm = volumetric_flow_m3_s / US_GALLON_M3 * 60.0
    specific_gravity = density_kg_m3 / WATER_REFERENCE_DENSITY
    return specific_gravity * (flow_gpm / cv) ** 2 * PSI_PA


def pressure_drop(inputs: dict) -> dict:
    """Pressure drop of an incompressible fluid through line segments in series.

    Inputs (SI-based engineering units, named with their unit):

    * `density_kg_m3`, `viscosity_mpa_s` (dynamic viscosity; 1 mPa.s = 1 cP)
    * exactly one of `mass_flow_kg_s` or `volumetric_flow_l_min`
    * `velocity_limit_m_s` (optional, default 3.0): velocities above it are
      reported as warnings; it does not change the result
    * `segments`: each with `name`, `inner_diameter_mm`, `length_m`,
      `roughness_mm` (absolute roughness), `k_sum` (sum of minor-loss
      K factors referred to this segment's velocity head),
      `elevation_change_m` (outlet minus inlet height, positive when the
      line rises), and `cv_items` (`[{name, cv}]`, US Cv, see
      `cv_pressure_drop_pa`)

    Per segment (Darcy-Weisbach):

        v = Q / (pi D^2 / 4)            Re = rho v D / mu
        dP_friction = f (L / D) rho v^2 / 2
        dP_minor    = K_sum rho v^2 / 2
        dP_elevation = rho g dz          (negative when the line falls)
        dP_components = sum of Cv drops

    Results are pressure DROPS in kPa: positive values reduce the pressure
    along the flow direction. The same flow passes through every segment.
    """
    density = float(inputs["density_kg_m3"])
    viscosity = float(inputs["viscosity_mpa_s"]) * 1.0e-3  # Pa.s
    mass_flow = inputs.get("mass_flow_kg_s")
    volumetric_l_min = inputs.get("volumetric_flow_l_min")
    if (mass_flow is None) == (volumetric_l_min is None):
        raise AnalysisInputError("Give either a mass flow or a volumetric flow, not both.")
    if density <= 0 or viscosity <= 0:
        raise AnalysisInputError("Density and viscosity must be greater than zero.")
    if mass_flow is not None:
        flow_m3_s = float(mass_flow) / density
    else:
        flow_m3_s = float(volumetric_l_min) / 60000.0
    if flow_m3_s <= 0:
        raise AnalysisInputError("Flow must be greater than zero.")
    segments = inputs.get("segments") or []
    if not segments:
        raise AnalysisInputError("Add at least one line segment.")
    limit_input = inputs.get("velocity_limit_m_s")
    velocity_limit = DEFAULT_VELOCITY_LIMIT_M_S if limit_input is None else float(limit_input)

    warnings: list[str] = []
    rows: list[dict] = []
    totals = {"friction": 0.0, "minor": 0.0, "components": 0.0, "elevation": 0.0}
    any_cv = False
    for index, segment in enumerate(segments, start=1):
        name = (segment.get("name") or "").strip() or f"Segment {index}"
        diameter = float(segment["inner_diameter_mm"]) * 1.0e-3
        length = float(segment.get("length_m") or 0.0)
        roughness = float(segment.get("roughness_mm") or 0.0) * 1.0e-3
        k_sum = float(segment.get("k_sum") or 0.0)
        elevation = float(segment.get("elevation_change_m") or 0.0)
        if diameter <= 0:
            raise AnalysisInputError(f"{name}: inner diameter must be greater than zero.")
        if length < 0 or roughness < 0 or k_sum < 0:
            raise AnalysisInputError(f"{name}: length, roughness, and K must not be negative.")

        area = math.pi * diameter**2 / 4.0
        velocity = flow_m3_s / area
        reynolds = density * velocity * diameter / viscosity
        relative_roughness = roughness / diameter
        factor, regime = friction_factor(reynolds, relative_roughness)
        velocity_head = density * velocity**2 / 2.0  # Pa
        dp_friction = factor * (length / diameter) * velocity_head
        dp_minor = k_sum * velocity_head
        dp_elevation = density * G0 * elevation
        dp_components = 0.0
        for item in segment.get("cv_items") or []:
            any_cv = True
            dp_components += cv_pressure_drop_pa(flow_m3_s, float(item["cv"]), density)
        dp_total = dp_friction + dp_minor + dp_components + dp_elevation

        if regime == "transitional":
            warnings.append(
                f"{name}: transitional flow (Re = {reynolds:.0f}, between 2300 and 4000). "
                "The friction factor is uncertain here; the larger of the laminar and "
                "turbulent values was used."
            )
        if regime == "turbulent":
            low, high = SWAMEE_JAIN_RE_RANGE
            if reynolds < low or reynolds > high:
                warnings.append(
                    f"{name}: Re = {reynolds:.3g} is outside the Swamee-Jain range "
                    "(5e3 to 1e8); the friction factor is extrapolated."
                )
        if regime != "laminar":
            low, high = SWAMEE_JAIN_ROUGHNESS_RANGE
            if relative_roughness > high:
                warnings.append(
                    f"{name}: relative roughness {relative_roughness:.3g} is above the "
                    "Swamee-Jain range (1e-6 to 1e-2); the friction factor is extrapolated."
                )
            elif 0 < relative_roughness < low:
                warnings.append(
                    f"{name}: relative roughness {relative_roughness:.3g} is below the "
                    "Swamee-Jain range (1e-6 to 1e-2); the pipe is treated as nearly smooth."
                )
        if velocity > velocity_limit:
            warnings.append(
                f"{name}: velocity {velocity:.2f} m/s is above the limit of "
                f"{velocity_limit:g} m/s set for this analysis."
            )

        totals["friction"] += dp_friction
        totals["minor"] += dp_minor
        totals["components"] += dp_components
        totals["elevation"] += dp_elevation
        rows.append(
            {
                "name": name,
                "velocity_m_s": velocity,
                "reynolds": reynolds,
                "flow_regime": regime,
                "relative_roughness": relative_roughness,
                "friction_factor": factor,
                "dp_friction_kpa": dp_friction / 1000.0,
                "dp_minor_kpa": dp_minor / 1000.0,
                "dp_components_kpa": dp_components / 1000.0,
                "dp_elevation_kpa": dp_elevation / 1000.0,
                "dp_total_kpa": dp_total / 1000.0,
            }
        )

    total_pa = sum(totals.values())
    if total_pa < 0:
        warnings.append(
            "The total is negative: the static head gained on the way down exceeds the "
            "losses, so the pressure rises along the line."
        )
    assumptions = [
        "Steady, single-phase, incompressible flow; the same flow passes through every "
        "segment in series.",
        "Friction: Darcy-Weisbach with f = 64/Re below Re 2300 and the Swamee-Jain "
        "correlation from Re 4000.",
        "Minor losses use each segment's own velocity head (dP = K rho v^2 / 2).",
        "Elevation head uses g = 9.80665 m/s^2; a rising line adds to the pressure drop.",
        "Not checked: cavitation, flashing, choked flow, and compressibility.",
    ]
    if any_cv:
        assumptions.append(
            "Cv is the US flow coefficient (US gal/min of 60 degF water at 1 psi drop, "
            "specific gravity referred to 999.0 kg/m^3); Kv values must be converted "
            "with Cv = 1.156 Kv."
        )
    return {
        "calc_version": CALC_VERSION,
        "kind": "pressure_drop",
        "flow": {
            "mass_flow_kg_s": flow_m3_s * density,
            "volumetric_flow_l_min": flow_m3_s * 60000.0,
        },
        "segments": rows,
        "totals": {
            "dp_friction_kpa": totals["friction"] / 1000.0,
            "dp_minor_kpa": totals["minor"] / 1000.0,
            "dp_components_kpa": totals["components"] / 1000.0,
            "dp_elevation_kpa": totals["elevation"] / 1000.0,
            "dp_total_kpa": total_pa / 1000.0,
            "dp_total_bar": total_pa / 1.0e5,
            "head_loss_m": total_pa / (density * G0),
        },
        "warnings": warnings,
        "assumptions": assumptions,
    }


# --------------------------------------------------------------------------
# Relief valve sizing (API Standard 520 Part I, SI units)
# --------------------------------------------------------------------------

# API Standard 526 effective orifice areas by letter designation, in^2.
API_526_ORIFICES_IN2: list[tuple[str, float]] = [
    ("D", 0.110),
    ("E", 0.196),
    ("F", 0.307),
    ("G", 0.503),
    ("H", 0.785),
    ("J", 1.287),
    ("K", 1.838),
    ("L", 2.853),
    ("M", 3.60),
    ("N", 4.34),
    ("P", 6.38),
    ("Q", 11.05),
    ("R", 16.0),
    ("T", 26.0),
]
IN2_TO_MM2 = 645.16  # exact

DEFAULT_KD_GAS = 0.975
DEFAULT_KD_LIQUID = 0.65
# The 10th-edition viscosity correction is stated for Reynolds numbers above this.
KV_MIN_REYNOLDS = 80.0


def api_526_orifice(required_area_mm2: float) -> dict | None:
    """Smallest API 526 orifice whose effective area covers the required area.

    Returns `{letter, area_mm2, area_in2}`, or None when the area exceeds the
    largest standard orifice (T, 26.0 in^2).
    """
    for letter, area_in2 in API_526_ORIFICES_IN2:
        area_mm2 = area_in2 * IN2_TO_MM2
        if area_mm2 >= required_area_mm2:
            return {"letter": letter, "area_mm2": area_mm2, "area_in2": area_in2}
    return None


def gas_coefficient_c(k: float) -> float:
    """API 520 coefficient C for critical gas flow, SI form.

        C = 0.03948 * sqrt(k * (2 / (k + 1))^((k + 1) / (k - 1)))

    Units: sqrt(kg.kmol.K) / (mm^2.h.kPa), for A in mm^2, W in kg/h, P1 in
    kPa abs, T in K, M in kg/kmol. The constant is 3.6 / sqrt(R) with
    R = 8314.46 J/(kmol.K), i.e. the ideal isentropic nozzle. Requires k > 1.
    """
    if k <= 1.0:
        raise AnalysisInputError("The ratio of specific heats k must be greater than 1.")
    return 0.03948 * math.sqrt(k * (2.0 / (k + 1.0)) ** ((k + 1.0) / (k - 1.0)))


def critical_pressure_ratio(k: float) -> float:
    """Critical flow pressure ratio Pcf / P1 = (2 / (k + 1))^(k / (k - 1)), absolute."""
    if k <= 1.0:
        raise AnalysisInputError("The ratio of specific heats k must be greater than 1.")
    return (2.0 / (k + 1.0)) ** (k / (k - 1.0))


def subcritical_coefficient_f2(k: float, pressure_ratio: float) -> float:
    """API 520 coefficient F2 for subcritical gas flow.

        F2 = sqrt( (k / (k - 1)) * r^(2/k) * (1 - r^((k - 1)/k)) / (1 - r) )

    with r = P2 / P1 (absolute back pressure over absolute relieving pressure).
    """
    if k <= 1.0:
        raise AnalysisInputError("The ratio of specific heats k must be greater than 1.")
    r = pressure_ratio
    if not 0.0 < r < 1.0:
        raise AnalysisInputError("Back pressure must be below the relieving pressure.")
    return math.sqrt(
        (k / (k - 1.0)) * r ** (2.0 / k) * (1.0 - r ** ((k - 1.0) / k)) / (1.0 - r)
    )


def gas_relief_area_mm2(
    *,
    mass_rate_kg_h: float,
    relieving_pressure_kpa_abs: float,
    back_pressure_kpa_abs: float,
    temperature_k: float,
    molar_mass_kg_kmol: float,
    k: float,
    z: float = 1.0,
    kd: float = DEFAULT_KD_GAS,
    kb: float = 1.0,
    kc: float = 1.0,
) -> tuple[float, str, dict]:
    """Required effective discharge area for gas or vapour relief, API 520 Part I (SI).

    Critical flow (P2 <= Pcf):

        A = W / (C Kd P1 Kb Kc) * sqrt(T Z / M)

    Subcritical flow (P2 > Pcf; conventional and pilot-operated valves, Kb not used):

        A = 17.9 W / (F2 Kd Kc) * sqrt(Z T / (M P1 (P1 - P2)))

    A in mm^2, W in kg/h, P1 and P2 in kPa abs, T in K, M in kg/kmol.
    Returns `(area_mm2, regime, details)` with regime "critical" or "subcritical".
    """
    p1 = relieving_pressure_kpa_abs
    p2 = back_pressure_kpa_abs
    if min(mass_rate_kg_h, p1, temperature_k, molar_mass_kg_kmol, z, kd, kb, kc) <= 0:
        raise AnalysisInputError(
            "Relieving rate, pressure, temperature, molar mass, Z, and the K factors must "
            "be greater than zero."
        )
    if p2 >= p1:
        raise AnalysisInputError("Back pressure must be below the relieving pressure.")
    ratio_critical = critical_pressure_ratio(k)
    critical_flow_pressure = ratio_critical * p1
    details = {
        "critical_pressure_ratio": ratio_critical,
        "critical_flow_pressure_kpa_abs": critical_flow_pressure,
    }
    if p2 <= critical_flow_pressure:
        c = gas_coefficient_c(k)
        area = mass_rate_kg_h / (c * kd * p1 * kb * kc) * math.sqrt(
            temperature_k * z / molar_mass_kg_kmol
        )
        return area, "critical", {**details, "coefficient_c": c}
    f2 = subcritical_coefficient_f2(k, p2 / p1)
    area = (
        17.9
        * mass_rate_kg_h
        / (f2 * kd * kc)
        * math.sqrt(z * temperature_k / (molar_mass_kg_kmol * p1 * (p1 - p2)))
    )
    return area, "subcritical", {**details, "coefficient_f2": f2}


def liquid_relief_area_mm2(
    *,
    volume_rate_l_min: float,
    specific_gravity: float,
    relieving_pressure_kpag: float,
    back_pressure_kpag: float,
    kd: float = DEFAULT_KD_LIQUID,
    kw: float = 1.0,
    kc: float = 1.0,
    kv: float = 1.0,
) -> float:
    """Required effective area for liquid relief, API 520 Part I (SI), certified valves.

        A = 11.78 Q / (Kd Kw Kc Kv) * sqrt(G / (P1 - P2))

    A in mm^2, Q in L/min, P1 (relieving) and P2 (total back pressure) in
    kPa gauge, G = specific gravity at flowing temperature referred to water.
    The constant is the orifice equation Q = Kd A sqrt(2 dP / rho) in these units.
    """
    if min(volume_rate_l_min, specific_gravity, kd, kw, kc, kv) <= 0:
        raise AnalysisInputError(
            "Relieving rate, density, and the K factors must be greater than zero."
        )
    differential = relieving_pressure_kpag - back_pressure_kpag
    if differential <= 0:
        raise AnalysisInputError("Back pressure must be below the relieving pressure.")
    return (
        11.78
        * volume_rate_l_min
        / (kd * kw * kc * kv)
        * math.sqrt(specific_gravity / differential)
    )


def liquid_relief_reynolds(
    volume_rate_l_min: float, specific_gravity: float, viscosity_mpa_s: float, area_mm2: float
) -> float:
    """Reynolds number at the orifice per API 520: Re = Q (18800 G) / (mu sqrt(A)).

    Q in L/min, mu in mPa.s (cP), A in mm^2 (the selected orifice's effective area).
    """
    return volume_rate_l_min * 18800.0 * specific_gravity / (viscosity_mpa_s * math.sqrt(area_mm2))


def viscosity_correction_kv(reynolds: float) -> float:
    """Viscosity correction Kv, API 520 Part I 10th edition: Kv = (1 + 170 / Re)^-0.5.

    Stated there for Re > 80. (Editions 7 to 9 used
    Kv = 1 / (0.9935 + 2.878 / Re^0.5 + 342.75 / Re^1.5), which agrees within a
    few percent over the common range.)
    """
    if reynolds <= 0:
        raise AnalysisInputError("Reynolds number must be positive.")
    return 1.0 / math.sqrt(1.0 + 170.0 / reynolds)


def _orifice_result(required_area_mm2: float, warnings: list[str]) -> dict | None:
    orifice = api_526_orifice(required_area_mm2)
    if orifice is None:
        largest = API_526_ORIFICES_IN2[-1][1] * IN2_TO_MM2
        warnings.append(
            f"The required area exceeds the largest API 526 orifice (T, {largest:.0f} mm^2); "
            "more than one valve or a non-standard device is needed."
        )
    return orifice


def _common_relief_warnings(inputs: dict, service: str, warnings: list[str]) -> None:
    overpressure = float(inputs["overpressure_pct"])
    if overpressure not in (10.0, 16.0, 21.0):
        warnings.append(
            f"Overpressure of {overpressure:g} % is not one of the usual ASME Section VIII "
            "allowances (10 % single valve, 16 % multiple valves, 21 % fire case); "
            "confirm it against the governing code."
        )
    set_pressure = float(inputs["set_pressure_kpag"])
    back_pressure = float(inputs.get("back_pressure_kpag") or 0.0)
    if back_pressure > 0.1 * set_pressure:
        warnings.append(
            "Back pressure is above 10 % of the set pressure; a conventional valve may "
            "not be suitable. Confirm the valve type and its back pressure correction "
            + ("(Kb) " if service == "gas" else "(Kw) ")
            + "with the manufacturer."
        )
    if inputs.get("kd") is None:
        default = DEFAULT_KD_GAS if service == "gas" else DEFAULT_KD_LIQUID
        warnings.append(
            f"Kd = {default} is the API 520 preliminary sizing value; use the "
            "manufacturer's certified coefficient for the final selection."
        )


def relief_sizing(inputs: dict) -> dict:
    """Relief valve sizing per API Standard 520 Part I (SI units).

    Common inputs: `service` ("gas" or "liquid"), `set_pressure_kpag`,
    `overpressure_pct` (default 10), `back_pressure_kpag` (total back
    pressure at the valve outlet while relieving, default 0),
    `atmospheric_pressure_kpa` (default 101.325), `kd` (default 0.975 gas,
    0.65 liquid), `kc` (default 1.0; 0.9 with an uncertified rupture disc
    upstream).

    Gas: `mass_rate_kg_h`, `relieving_temperature_c`, `molar_mass_kg_kmol`,
    `k` (ideal-gas ratio of specific heats at relieving conditions), `z`
    (default 1.0), `kb` (default 1.0).

    Liquid: `volume_rate_l_min`, `density_kg_m3`, `kw` (default 1.0),
    `viscosity_mpa_s` (optional; when given the API viscosity correction is
    applied, otherwise Kv = 1 with a warning).

    Relieving pressure P1 = set pressure * (1 + overpressure / 100), plus
    atmospheric pressure for the gas equations.
    """
    service = inputs.get("service")
    if service not in ("gas", "liquid"):
        raise AnalysisInputError("Service must be gas or liquid.")
    set_pressure = float(inputs["set_pressure_kpag"])
    overpressure = float(inputs["overpressure_pct"])
    back_pressure = float(inputs.get("back_pressure_kpag") or 0.0)
    atmosphere_input = inputs.get("atmospheric_pressure_kpa")
    atmosphere = STANDARD_ATMOSPHERE_KPA if atmosphere_input is None else float(atmosphere_input)
    kc = float(inputs.get("kc") or 1.0)
    if set_pressure <= 0:
        raise AnalysisInputError("Set pressure must be greater than zero.")
    if overpressure < 0 or back_pressure < 0:
        raise AnalysisInputError("Overpressure and back pressure must not be negative.")
    relieving_kpag = set_pressure * (1.0 + overpressure / 100.0)

    warnings: list[str] = []
    assumptions = [
        "API Standard 520 Part I preliminary sizing in SI units; the area is an API "
        "effective area for choosing an API 526 orifice letter.",
        "Relieving pressure = set pressure x (1 + overpressure/100)"
        + (" + atmospheric pressure." if service == "gas" else " (gauge)."),
        "The required relieving rate is an input: the relief scenario (blocked outlet, "
        "fire, thermal expansion, regulator failure) is not derived here.",
        "Not covered: inlet line loss (3 % rule), outlet piping, reaction forces, steam, "
        "and two-phase flow.",
    ]
    _common_relief_warnings(inputs, service, warnings)
    result: dict = {
        "calc_version": CALC_VERSION,
        "kind": "relief_sizing",
        "service": service,
        "relieving_pressure_kpag": relieving_kpag,
    }

    if service == "gas":
        kd = DEFAULT_KD_GAS if inputs.get("kd") is None else float(inputs["kd"])
        kb = float(inputs.get("kb") or 1.0)
        k = float(inputs["k"])
        z = float(inputs.get("z") or 1.0)
        temperature_k = float(inputs["relieving_temperature_c"]) + 273.15
        if temperature_k <= 0:
            raise AnalysisInputError("Relieving temperature is below absolute zero.")
        p1 = relieving_kpag + atmosphere
        p2 = back_pressure + atmosphere
        area, regime, details = gas_relief_area_mm2(
            mass_rate_kg_h=float(inputs["mass_rate_kg_h"]),
            relieving_pressure_kpa_abs=p1,
            back_pressure_kpa_abs=p2,
            temperature_k=temperature_k,
            molar_mass_kg_kmol=float(inputs["molar_mass_kg_kmol"]),
            k=k,
            z=z,
            kd=kd,
            kb=kb,
            kc=kc,
        )
        assumptions.append(
            "Gas or vapour treated as an ideal gas corrected by Z, expanding "
            "isentropically with constant k."
        )
        if regime == "critical":
            assumptions.append(
                "Critical (choked) flow: back pressure is at or below the critical flow "
                "pressure, A = W / (C Kd P1 Kb Kc) x sqrt(T Z / M)."
            )
            if back_pressure > 0 and kb == 1.0:
                warnings.append(
                    "Kb = 1 assumes a conventional or pilot-operated valve; for a balanced "
                    "bellows valve take Kb from the manufacturer's curve."
                )
        else:
            assumptions.append(
                "Subcritical flow: back pressure is above the critical flow pressure, "
                "A = 17.9 W / (F2 Kd Kc) x sqrt(Z T / (M P1 (P1 - P2)))."
            )
            warnings.append(
                "Subcritical flow: the equation applies to conventional and pilot-operated "
                "valves and does not use Kb. Size a balanced bellows valve with the "
                "critical flow equation and the manufacturer's Kb instead."
            )
        if not 1.0 < k <= 2.0:
            warnings.append(f"k = {k:g} is outside the usual range for gases (1.0 to 2.0).")
        if z < 0.8 or z > 1.1:
            warnings.append(
                f"Z = {z:g} is far from ideal-gas behaviour; near the critical point the "
                "ideal-gas sizing equations lose accuracy and a real-gas method is needed."
            )
        result.update(
            {
                "flow_regime": regime,
                "relieving_pressure_kpa_abs": p1,
                "back_pressure_kpa_abs": p2,
                "relieving_temperature_k": temperature_k,
                "factors": {"kd": kd, "kb": kb if regime == "critical" else None, "kc": kc},
                **details,
            }
        )
    else:
        kd = DEFAULT_KD_LIQUID if inputs.get("kd") is None else float(inputs["kd"])
        kw = float(inputs.get("kw") or 1.0)
        density = float(inputs["density_kg_m3"])
        rate = float(inputs["volume_rate_l_min"])
        specific_gravity = density / WATER_REFERENCE_DENSITY
        arguments = {
            "volume_rate_l_min": rate,
            "specific_gravity": specific_gravity,
            "relieving_pressure_kpag": relieving_kpag,
            "back_pressure_kpag": back_pressure,
            "kd": kd,
            "kw": kw,
            "kc": kc,
        }
        preliminary = liquid_relief_area_mm2(**arguments, kv=1.0)
        area = preliminary
        kv = 1.0
        reynolds = None
        viscosity = inputs.get("viscosity_mpa_s")
        assumptions.append(
            "Liquid relief through a valve that requires capacity certification, "
            "A = 11.78 Q / (Kd Kw Kc Kv) x sqrt(G / (P1 - P2)), with specific gravity "
            "referred to water at 999.0 kg/m^3. The liquid does not flash."
        )
        if viscosity is None:
            warnings.append(
                "No viscosity given: the viscosity correction Kv is taken as 1. This is "
                "only acceptable for thin liquids (roughly below 100 mPa.s)."
            )
        else:
            viscosity = float(viscosity)
            if viscosity <= 0:
                raise AnalysisInputError("Viscosity must be greater than zero.")
            # API procedure: size with Kv = 1, pick the next standard orifice, compute
            # Re and Kv for that orifice, and step up while the corrected area exceeds it.
            for _letter, area_in2 in API_526_ORIFICES_IN2:
                candidate = area_in2 * IN2_TO_MM2
                if candidate < preliminary:
                    continue
                reynolds = liquid_relief_reynolds(rate, specific_gravity, viscosity, candidate)
                kv = viscosity_correction_kv(reynolds)
                area = preliminary / kv
                if area <= candidate:
                    break
            else:
                # No standard orifice covers it: solve A = A0 / Kv(Re(A)) for the area
                # itself. The fixed point converges because 1/Kv grows only as A^0.25.
                area = preliminary
                for _ in range(100):
                    reynolds = liquid_relief_reynolds(rate, specific_gravity, viscosity, area)
                    kv = viscosity_correction_kv(reynolds)
                    area = preliminary / kv
            assumptions.append(
                "Viscosity correction per API 520 Part I 10th edition, "
                "Kv = (1 + 170/Re)^-0.5 with Re = Q (18800 G) / (mu sqrt(A)) evaluated for "
                "the selected standard orifice."
            )
            if reynolds < KV_MIN_REYNOLDS:
                warnings.append(
                    f"Reynolds number {reynolds:.0f} is below 80, the lower limit of the "
                    "API viscosity correction; confirm the size with the manufacturer."
                )
        if kw == 1.0 and back_pressure > 0:
            warnings.append(
                "Kw = 1 assumes a conventional or pilot-operated valve; for a balanced "
                "bellows valve take Kw from the manufacturer's curve."
            )
        result.update(
            {
                "flow_regime": "liquid",
                "specific_gravity": specific_gravity,
                "preliminary_area_mm2": preliminary,
                "reynolds": reynolds,
                "factors": {"kd": kd, "kw": kw, "kc": kc, "kv": kv},
            }
        )

    orifice = _orifice_result(area, warnings)
    result.update(
        {
            "required_area_mm2": area,
            "required_area_in2": area / IN2_TO_MM2,
            "orifice": orifice,
            "warnings": warnings,
            "assumptions": assumptions,
        }
    )
    return result


ANALYSIS_KINDS = ("pressure_drop", "relief_sizing")


def run_analysis(kind: str, inputs: dict) -> dict:
    """Compute the results of an analysis of the given kind from validated inputs."""
    if kind == "pressure_drop":
        return pressure_drop(inputs)
    if kind == "relief_sizing":
        return relief_sizing(inputs)
    raise AnalysisInputError(f"Unknown analysis kind '{kind}'.")
