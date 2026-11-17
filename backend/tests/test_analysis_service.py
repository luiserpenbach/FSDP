"""Reference checks for the analysis calculators.

Each expected value is worked out here from the governing equation with plain
arithmetic (or taken from a published example), independently of the service
code, so a wrong constant or unit conversion in the service fails a test.
"""

import math

import pytest

from app.services import analysis
from app.services.analysis import (
    AnalysisInputError,
    api_526_orifice,
    critical_pressure_ratio,
    cv_pressure_drop_pa,
    friction_factor,
    gas_coefficient_c,
    gas_relief_area_mm2,
    liquid_relief_area_mm2,
    pressure_drop,
    relief_sizing,
    subcritical_coefficient_f2,
    swamee_jain_friction_factor,
    viscosity_correction_kv,
)

WATER = {"density_kg_m3": 998.2, "viscosity_mpa_s": 1.002}


def _segment(**overrides) -> dict:
    return {"name": "L1", "inner_diameter_mm": 25.0, "length_m": 10.0, **overrides}


# ---- pressure drop ----


def test_laminar_flow_matches_hagen_poiseuille() -> None:
    # Oil, 10 L/min through 5 m of 20 mm bore. Exact laminar solution:
    # dP = 128 mu L Q / (pi D^4).
    density, viscosity = 870.0, 0.100  # kg/m^3, Pa.s
    flow = 10.0 / 60000.0  # m^3/s
    diameter, length = 0.020, 5.0
    expected_pa = 128 * viscosity * length * flow / (math.pi * diameter**4)
    reynolds = density * (flow / (math.pi * diameter**2 / 4)) * diameter / viscosity
    assert reynolds == pytest.approx(92.3, rel=1e-3)  # well inside laminar

    result = pressure_drop(
        {
            "density_kg_m3": density,
            "viscosity_mpa_s": 100.0,
            "volumetric_flow_l_min": 10.0,
            "segments": [_segment(inner_diameter_mm=20.0, length_m=5.0, roughness_mm=0.05)],
        }
    )

    row = result["segments"][0]
    assert row["flow_regime"] == "laminar"
    assert row["friction_factor"] == pytest.approx(64 / reynolds)
    assert row["dp_friction_kpa"] == pytest.approx(expected_pa / 1000, rel=1e-9)
    assert expected_pa / 1000 == pytest.approx(21.22, rel=1e-3)
    # Roughness does not matter in laminar flow, and nothing is flagged.
    assert result["warnings"] == []


def test_turbulent_flow_matches_hand_calculation() -> None:
    # Water at 20 degC, 1 L/s (60 L/min) through 10 m of 25 mm bore, eps = 0.045 mm.
    #   A  = pi * 0.025^2 / 4            = 4.90874e-4 m^2
    #   v  = 0.001 / A                   = 2.03718 m/s
    #   Re = 998.2 * v * 0.025 / 1.002e-3 = 50 736
    #   eps/D = 0.0018
    #   Swamee-Jain: 0.0018/3.7 + 5.74/Re^0.9 = 4.8649e-4 + 3.3429e-4 = 8.2078e-4
    #                log10 = -3.08577, f = 0.25 / 3.08577^2 = 0.026255
    #   dP = f * (10/0.025) * 998.2 * v^2 / 2 = 0.026255 * 400 * 2071.3 = 21 753 Pa
    result = pressure_drop(
        {**WATER, "volumetric_flow_l_min": 60.0, "segments": [_segment(roughness_mm=0.045)]}
    )

    row = result["segments"][0]
    assert row["velocity_m_s"] == pytest.approx(2.03718, rel=1e-5)
    assert row["reynolds"] == pytest.approx(50736, rel=1e-4)
    assert row["flow_regime"] == "turbulent"
    assert row["relative_roughness"] == pytest.approx(0.0018)
    assert row["friction_factor"] == pytest.approx(0.026255, rel=1e-4)
    assert row["dp_friction_kpa"] == pytest.approx(21.753, rel=1e-4)
    assert result["totals"]["dp_total_kpa"] == pytest.approx(21.753, rel=1e-4)
    assert result["totals"]["dp_total_bar"] == pytest.approx(0.21753, rel=1e-4)
    assert result["totals"]["head_loss_m"] == pytest.approx(21753 / (998.2 * 9.80665), rel=1e-4)
    assert result["flow"]["mass_flow_kg_s"] == pytest.approx(0.9982)


@pytest.mark.parametrize(
    ("reynolds", "relative_roughness"),
    [(5.0e3, 0.0), (5.0e4, 0.0018), (1.0e5, 1.0e-4), (1.0e6, 1.0e-2), (1.0e7, 1.0e-5)],
)
def test_swamee_jain_tracks_colebrook(reynolds: float, relative_roughness: float) -> None:
    # Colebrook-White solved by fixed-point iteration is the reference.
    colebrook = 0.02
    for _ in range(200):
        colebrook = (
            -2.0
            * math.log10(relative_roughness / 3.7 + 2.51 / (reynolds * math.sqrt(colebrook)))
        ) ** -2
    assert swamee_jain_friction_factor(reynolds, relative_roughness) == pytest.approx(
        colebrook, rel=0.03
    )


def test_friction_factor_regimes() -> None:
    assert friction_factor(1000, 0.01) == (pytest.approx(0.064), "laminar")
    factor, regime = friction_factor(3000, 0.0)
    assert regime == "transitional"
    # The conservative (larger) of laminar 64/3000 = 0.0213 and the turbulent value.
    assert factor == pytest.approx(swamee_jain_friction_factor(3000, 0.0))
    assert factor > 64 / 3000
    assert friction_factor(4000, 0.0)[1] == "turbulent"


def test_minor_losses_and_elevation_head() -> None:
    # Same flow as the turbulent case: velocity head = 998.2 * 2.03718^2 / 2 = 2071.3 Pa.
    # K = 2.5 -> 5178 Pa. A 10 m rise adds rho g dz = 998.2 * 9.80665 * 10 = 97 890 Pa.
    result = pressure_drop(
        {
            **WATER,
            "volumetric_flow_l_min": 60.0,
            "segments": [_segment(length_m=0, k_sum=2.5, elevation_change_m=10.0)],
        }
    )
    row = result["segments"][0]
    assert row["dp_friction_kpa"] == 0
    assert row["dp_minor_kpa"] == pytest.approx(5.1783, rel=1e-4)
    assert row["dp_elevation_kpa"] == pytest.approx(97.890, rel=1e-4)
    assert row["dp_total_kpa"] == pytest.approx(103.068, rel=1e-4)

    falling = pressure_drop(
        {
            **WATER,
            "volumetric_flow_l_min": 60.0,
            "segments": [_segment(length_m=0, elevation_change_m=-10.0)],
        }
    )
    assert falling["totals"]["dp_total_kpa"] == pytest.approx(-97.890, rel=1e-4)
    assert any("negative" in warning for warning in falling["warnings"])


def test_cv_is_the_us_flow_coefficient() -> None:
    # Definition: 10 US gpm of water (SG 1) through Cv 5 drops (10/5)^2 = 4 psi.
    ten_gpm = 10 * 3.785411784e-3 / 60  # m^3/s
    assert cv_pressure_drop_pa(ten_gpm, 5.0, 999.0) == pytest.approx(4 * 6894.757, rel=1e-6)
    # A liquid of SG 0.8 drops 0.8 times as much.
    assert cv_pressure_drop_pa(ten_gpm, 5.0, 799.2) == pytest.approx(0.8 * 4 * 6894.757, rel=1e-6)
    # Cross-check against the metric Kv: Kv 1 passes 1 m^3/h of water at 1 bar,
    # and Cv = 1.156 Kv.
    assert cv_pressure_drop_pa(1 / 3600, 1.156, 1000.0) == pytest.approx(1.0e5, rel=2e-3)
    with pytest.raises(AnalysisInputError):
        cv_pressure_drop_pa(ten_gpm, 0.0, 999.0)


def test_cv_items_add_to_the_segment_and_series_segments_sum() -> None:
    result = pressure_drop(
        {
            "density_kg_m3": 999.0,
            "viscosity_mpa_s": 1.0,
            "volumetric_flow_l_min": 10 * 3.785411784,  # 10 US gpm
            "segments": [
                _segment(name="Inlet", cv_items=[{"name": "HV-1", "cv": 5.0}]),
                _segment(name="Outlet", inner_diameter_mm=15.0, length_m=2.0),
            ],
        }
    )
    inlet, outlet = result["segments"]
    assert inlet["dp_components_kpa"] == pytest.approx(27.579, rel=1e-4)  # 4 psi
    assert outlet["dp_components_kpa"] == 0
    # Continuity: velocity scales with (25/15)^2.
    assert outlet["velocity_m_s"] == pytest.approx(inlet["velocity_m_s"] * (25 / 15) ** 2)
    assert result["totals"]["dp_total_kpa"] == pytest.approx(
        inlet["dp_total_kpa"] + outlet["dp_total_kpa"]
    )
    assert any("Cv is the US flow coefficient" in text for text in result["assumptions"])


def test_mass_flow_and_volumetric_flow_are_equivalent() -> None:
    by_volume = pressure_drop({**WATER, "volumetric_flow_l_min": 60.0, "segments": [_segment()]})
    by_mass = pressure_drop({**WATER, "mass_flow_kg_s": 0.9982, "segments": [_segment()]})
    assert by_mass["totals"]["dp_total_kpa"] == pytest.approx(by_volume["totals"]["dp_total_kpa"])


def test_pressure_drop_warnings() -> None:
    fast = pressure_drop({**WATER, "volumetric_flow_l_min": 120.0, "segments": [_segment()]})
    assert any("velocity 4.07 m/s is above the limit of 3 m/s" in w for w in fast["warnings"])
    relaxed = pressure_drop(
        {
            **WATER,
            "volumetric_flow_l_min": 120.0,
            "velocity_limit_m_s": 5.0,
            "segments": [_segment()],
        }
    )
    assert relaxed["warnings"] == []
    # 3.5 L/min in 25 mm bore: Re = 2960, transitional.
    transitional = pressure_drop(
        {**WATER, "volumetric_flow_l_min": 3.5, "segments": [_segment()]}
    )
    assert transitional["segments"][0]["flow_regime"] == "transitional"
    assert any("transitional flow" in warning for warning in transitional["warnings"])
    rough = pressure_drop(
        {**WATER, "volumetric_flow_l_min": 60.0, "segments": [_segment(roughness_mm=1.0)]}
    )
    assert any("above the Swamee-Jain range" in warning for warning in rough["warnings"])


def test_pressure_drop_rejects_undefined_inputs() -> None:
    with pytest.raises(AnalysisInputError):
        pressure_drop({**WATER, "segments": [_segment()]})
    with pytest.raises(AnalysisInputError):
        pressure_drop(
            {
                **WATER,
                "volumetric_flow_l_min": 1.0,
                "mass_flow_kg_s": 1.0,
                "segments": [_segment()],
            }
        )
    with pytest.raises(AnalysisInputError):
        pressure_drop({**WATER, "volumetric_flow_l_min": 1.0, "segments": []})


# ---- relief sizing: gas ----

GAS_CONSTANT = 8314.46  # J/(kmol.K)

# API 520 Part I gas example: 24 270 kg/h of hydrocarbon vapour, M = 51, 348 K,
# Z = 0.90, k = 1.11, relieving pressure 670 kPa abs, Kd = 0.975, Kb = Kc = 1.
API_GAS = {
    "mass_rate_kg_h": 24270.0,
    "relieving_pressure_kpa_abs": 670.0,
    "temperature_k": 348.0,
    "molar_mass_kg_kmol": 51.0,
    "k": 1.11,
    "z": 0.90,
}


def _ideal_nozzle_mass_flux(p1_pa: float, p2_pa: float, t: float, m: float, k: float, z: float):
    """Isentropic ideal-gas nozzle mass flux in kg/(s.m^2), choked when p2 is low enough."""
    density = p1_pa * m / (z * GAS_CONSTANT * t)
    ratio = max(p2_pa / p1_pa, (2 / (k + 1)) ** (k / (k - 1)))
    return math.sqrt(
        2 * p1_pa * density * (k / (k - 1)) * (ratio ** (2 / k) - ratio ** ((k + 1) / k))
    )


def test_gas_coefficient_c_matches_published_values() -> None:
    # Air, k = 1.4: sqrt(1.4 * (2/2.4)^6) = sqrt(1.4 * 0.334898) = 0.684731,
    # C = 0.03948 * 0.684731 = 0.027033 (API tabulates 356 in US units = 520 * 0.684731).
    assert gas_coefficient_c(1.4) == pytest.approx(0.027033, rel=1e-4)
    assert 520 * gas_coefficient_c(1.4) / 0.03948 == pytest.approx(356, abs=0.5)
    # k = 1.11: (2/2.11)^(2.11/0.11) = 0.35807, sqrt(1.11 * 0.35807) = 0.63044 -> 0.024890.
    assert gas_coefficient_c(1.11) == pytest.approx(0.024890, rel=1e-4)
    assert critical_pressure_ratio(1.4) == pytest.approx(0.52828, rel=1e-4)
    with pytest.raises(AnalysisInputError):
        gas_coefficient_c(1.0)


def test_gas_critical_flow_matches_api_520_example() -> None:
    # Hand calculation:
    #   A = 24270 / (0.024890 * 0.975 * 670) * sqrt(348 * 0.90 / 51)
    #     = 24270 / 16.259 * 2.4781 = 3699 mm^2 = 5.73 in^2, the result of the API 520
    #     worked example, which selects a "P" orifice (6.38 in^2).
    area, regime, details = gas_relief_area_mm2(**API_GAS, back_pressure_kpa_abs=101.325)

    assert regime == "critical"
    assert area == pytest.approx(3699, rel=5e-4)
    assert area / 645.16 == pytest.approx(5.73, abs=0.005)
    assert details["coefficient_c"] == pytest.approx(0.024890, rel=1e-4)
    assert api_526_orifice(area)["letter"] == "P"


def test_gas_critical_flow_matches_first_principles_nozzle() -> None:
    # W = Kd * A * G with G the choked isentropic mass flux of an ideal gas.
    area, _regime, _details = gas_relief_area_mm2(**API_GAS, back_pressure_kpa_abs=101.325)
    flux = _ideal_nozzle_mass_flux(670.0e3, 101.325e3, 348.0, 51.0, 1.11, 0.90)
    expected_mm2 = (24270.0 / 3600.0) / (0.975 * flux) * 1.0e6
    assert area == pytest.approx(expected_mm2, rel=1e-3)


def test_gas_subcritical_flow_matches_api_520_example() -> None:
    # Same relief with 532 kPa abs back pressure: r = 532/670 = 0.794 is above the
    # critical ratio 0.582, so the flow is subcritical.
    #   F2^2 = (1.11/0.11) * r^(2/1.11) * (1 - r^(0.11/1.11)) / (1 - r)
    #        = 10.0909 * 0.65993 * 0.10971 = 0.7306 -> F2 = 0.8548
    #   A = 17.9 * 24270 / (0.8548 * 0.975) * sqrt(0.90 * 348 / (51 * 670 * 138))
    #     = 521 260 * 0.0081499 = 4248 mm^2
    ratio = 532.0 / 670.0
    assert critical_pressure_ratio(1.11) == pytest.approx(0.582, abs=0.001)
    assert subcritical_coefficient_f2(1.11, ratio) == pytest.approx(0.8548, rel=1e-3)

    area, regime, details = gas_relief_area_mm2(**API_GAS, back_pressure_kpa_abs=532.0)

    assert regime == "subcritical"
    assert area == pytest.approx(4248, rel=1e-3)
    assert details["coefficient_f2"] == pytest.approx(0.8548, rel=1e-3)
    # First principles: W = Kd * A * G(P1, P2) for the unchoked isentropic nozzle.
    flux = _ideal_nozzle_mass_flux(670.0e3, 532.0e3, 348.0, 51.0, 1.11, 0.90)
    assert area == pytest.approx((24270.0 / 3600.0) / (0.975 * flux) * 1.0e6, rel=1e-3)


def test_gas_equations_agree_at_the_critical_pressure_ratio() -> None:
    # Just below and just above the critical flow pressure the two API equations
    # must give the same area (within the rounding of their constants).
    critical = critical_pressure_ratio(1.11) * 670.0
    below, regime_below, _ = gas_relief_area_mm2(**API_GAS, back_pressure_kpa_abs=critical - 0.01)
    above, regime_above, _ = gas_relief_area_mm2(**API_GAS, back_pressure_kpa_abs=critical + 0.01)
    assert (regime_below, regime_above) == ("critical", "subcritical")
    assert above == pytest.approx(below, rel=2e-3)


def test_gas_relief_sizing_from_user_inputs() -> None:
    # Set 517 kPag + 10 % + 101.325 kPa = 670.0 kPa abs; 348 K = 74.85 degC.
    result = relief_sizing(
        {
            "service": "gas",
            "set_pressure_kpag": 517.0,
            "overpressure_pct": 10.0,
            "mass_rate_kg_h": 24270.0,
            "relieving_temperature_c": 74.85,
            "molar_mass_kg_kmol": 51.0,
            "k": 1.11,
            "z": 0.90,
        }
    )
    assert result["relieving_pressure_kpa_abs"] == pytest.approx(670.025)
    assert result["flow_regime"] == "critical"
    assert result["required_area_mm2"] == pytest.approx(3699, rel=1e-3)
    assert result["orifice"]["letter"] == "P"
    assert result["orifice"]["area_in2"] == 6.38
    assert result["factors"] == {"kd": 0.975, "kb": 1.0, "kc": 1.0}
    assert any("preliminary sizing value" in warning for warning in result["warnings"])
    assert result["calc_version"] == analysis.CALC_VERSION

    with_back_pressure = relief_sizing(
        {
            "service": "gas",
            "set_pressure_kpag": 517.0,
            "overpressure_pct": 10.0,
            "back_pressure_kpag": 532.0 - 101.325,
            "mass_rate_kg_h": 24270.0,
            "relieving_temperature_c": 74.85,
            "molar_mass_kg_kmol": 51.0,
            "k": 1.11,
            "z": 0.90,
            "kd": 0.975,
        }
    )
    assert with_back_pressure["flow_regime"] == "subcritical"
    assert with_back_pressure["required_area_mm2"] == pytest.approx(4248, rel=1e-3)
    assert with_back_pressure["orifice"]["letter"] == "Q"
    assert with_back_pressure["factors"]["kb"] is None
    warnings = " ".join(with_back_pressure["warnings"])
    assert "Subcritical flow" in warnings
    assert "above 10 % of the set pressure" in warnings
    assert "preliminary sizing value" not in warnings


# ---- relief sizing: liquid ----


def test_liquid_relief_matches_api_520_example() -> None:
    # API 520 Part I liquid example: 6814 L/min of crude oil, G = 0.90, set 1724 kPag,
    # 10 % overpressure (P1 = 1896 kPag), back pressure 345 kPag, Kd = 0.65, Kw = 0.97.
    #   A = 11.78 * 6814 / (0.65 * 0.97) * sqrt(0.90 / (1896 - 345))
    #     = 127 310 * 0.024089 = 3066 mm^2 (4.752 in^2)
    area = liquid_relief_area_mm2(
        volume_rate_l_min=6814.0,
        specific_gravity=0.90,
        relieving_pressure_kpag=1896.0,
        back_pressure_kpag=345.0,
        kd=0.65,
        kw=0.97,
    )
    assert area == pytest.approx(3066, rel=1e-3)
    assert area / 645.16 == pytest.approx(4.752, abs=0.01)


def test_liquid_relief_matches_orifice_equation() -> None:
    # Q = Kd * A * sqrt(2 dP / rho) with SI units throughout.
    area = liquid_relief_area_mm2(
        volume_rate_l_min=500.0,
        specific_gravity=1.0,
        relieving_pressure_kpag=1100.0,
        back_pressure_kpag=0.0,
        kd=0.65,
    )
    flow_m3_s = 500.0 / 60000.0
    expected_m2 = flow_m3_s / (0.65 * math.sqrt(2 * 1100.0e3 / 999.0))
    assert area == pytest.approx(expected_m2 * 1.0e6, rel=1e-3)


def test_viscosity_correction() -> None:
    # 10th edition: Re = 100 -> 1 / sqrt(1 + 1.7) = 0.6086; inviscid limit -> 1.
    assert viscosity_correction_kv(100) == pytest.approx(0.6086, rel=1e-3)
    assert viscosity_correction_kv(1.0e9) == pytest.approx(1.0, abs=1e-6)
    # The earlier-edition correlation agrees within a few percent over the common range.
    for reynolds in (100.0, 1000.0, 1.0e4, 1.0e5):
        earlier = 1 / (0.9935 + 2.878 / reynolds**0.5 + 342.75 / reynolds**1.5)
        assert viscosity_correction_kv(reynolds) == pytest.approx(earlier, rel=0.03)


def test_liquid_relief_sizing_with_and_without_viscosity() -> None:
    base = {
        "service": "liquid",
        "set_pressure_kpag": 1724.0,
        "overpressure_pct": 10.0,
        "back_pressure_kpag": 345.0,
        "volume_rate_l_min": 6814.0,
        "density_kg_m3": 0.90 * 999.0,
        "kd": 0.65,
        "kw": 0.97,
    }
    thin = relief_sizing(base)
    assert thin["required_area_mm2"] == pytest.approx(3066, rel=1e-3)
    assert thin["factors"]["kv"] == 1.0
    assert thin["orifice"]["letter"] == "P"
    assert any("Kv is taken as 1" in warning for warning in thin["warnings"])

    # 388 mPa.s (2000 SSU). Preliminary area 3066 mm^2 -> P orifice, 4116 mm^2.
    #   Re = 6814 * 18800 * 0.90 / (388 * sqrt(4116.12)) = 115 292 880 / 24 893 = 4632
    #   Kv = 1 / sqrt(1 + 170/4632) = 0.9821 -> A = 3066 / 0.9821 = 3122 mm^2 (still P)
    viscous = relief_sizing({**base, "viscosity_mpa_s": 388.0})
    assert viscous["reynolds"] == pytest.approx(4632, rel=1e-3)
    assert viscous["factors"]["kv"] == pytest.approx(0.9821, rel=1e-3)
    assert viscous["preliminary_area_mm2"] == pytest.approx(3066, rel=1e-3)
    assert viscous["required_area_mm2"] == pytest.approx(3122, rel=1e-3)
    assert viscous["orifice"]["letter"] == "P"
    assert not any("Kv is taken as 1" in warning for warning in viscous["warnings"])


def test_viscous_liquid_steps_up_to_the_next_orifice() -> None:
    # Preliminary area just under the F orifice (198.06 mm^2); the viscosity
    # correction pushes the required area past it, so G must be selected and Kv
    # re-evaluated for G.
    base = {
        "service": "liquid",
        "set_pressure_kpag": 1000.0,
        "overpressure_pct": 10.0,
        "volume_rate_l_min": 355.0,
        "density_kg_m3": 999.0,
        "kd": 0.65,
    }
    preliminary = relief_sizing(base)["required_area_mm2"]
    assert 190 < preliminary < 198.06

    result = relief_sizing({**base, "viscosity_mpa_s": 400.0})
    g_area = 0.503 * 645.16
    reynolds = 355.0 * 18800 * 1.0 / (400.0 * math.sqrt(g_area))
    kv = 1 / math.sqrt(1 + 170 / reynolds)
    assert result["orifice"]["letter"] == "G"
    assert result["reynolds"] == pytest.approx(reynolds)
    assert result["required_area_mm2"] == pytest.approx(preliminary / kv)
    assert result["required_area_mm2"] <= g_area


# ---- orifice selection and errors ----


def test_api_526_orifice_selection() -> None:
    assert api_526_orifice(1.0)["letter"] == "D"
    assert api_526_orifice(0.110 * 645.16)["letter"] == "D"
    assert api_526_orifice(0.110 * 645.16 + 0.01)["letter"] == "E"
    assert api_526_orifice(830.0)["letter"] == "J"  # J = 1.287 in^2 = 830.3 mm^2
    assert api_526_orifice(26.0 * 645.16)["letter"] == "T"
    assert api_526_orifice(26.0 * 645.16 + 1) is None
    letters = [letter for letter, _area in analysis.API_526_ORIFICES_IN2]
    assert letters == list("DEFGHJKLMNPQRT")


def test_relief_sizing_reports_areas_beyond_the_largest_orifice() -> None:
    result = relief_sizing(
        {
            "service": "gas",
            "set_pressure_kpag": 100.0,
            "overpressure_pct": 10.0,
            "mass_rate_kg_h": 200000.0,
            "relieving_temperature_c": 20.0,
            "molar_mass_kg_kmol": 28.97,
            "k": 1.4,
        }
    )
    assert result["orifice"] is None
    assert any("largest API 526 orifice" in warning for warning in result["warnings"])


def test_relief_sizing_rejects_back_pressure_at_or_above_relieving_pressure() -> None:
    with pytest.raises(AnalysisInputError):
        relief_sizing(
            {
                "service": "liquid",
                "set_pressure_kpag": 100.0,
                "overpressure_pct": 10.0,
                "back_pressure_kpag": 120.0,
                "volume_rate_l_min": 10.0,
                "density_kg_m3": 999.0,
            }
        )
    with pytest.raises(AnalysisInputError):
        gas_relief_area_mm2(**API_GAS, back_pressure_kpa_abs=670.0)


def test_unusual_overpressure_is_flagged() -> None:
    result = relief_sizing(
        {
            "service": "liquid",
            "set_pressure_kpag": 1000.0,
            "overpressure_pct": 25.0,
            "volume_rate_l_min": 100.0,
            "density_kg_m3": 999.0,
        }
    )
    assert any("Overpressure of 25 %" in warning for warning in result["warnings"])
