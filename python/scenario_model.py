"""Scenario configuration (spec section 3).

One common configuration object for Normal Operations, Increased Demand,
Safety First and Delivery Disruption. Applies adjustments to a copy of the
approved baseline; the baseline itself is never modified.
"""

import math

import demand_model

SCENARIOS = ("normal_operations", "increased_demand", "safety_first", "delivery_disruption")
METHOD = "common_scenario_config_v1"


def validate(cfg):
    """Check ranges (spec 3.2-3.4) and return a normalised copy."""
    errors = []

    def rng(name, lo, hi, integer=False):
        v = cfg.get(name)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or math.isnan(v):
            errors.append(f"{name} must be a number")
            return lo
        if integer and int(v) != v:
            errors.append(f"{name} must be a whole number")
        if v < lo or v > hi:
            errors.append(f"{name} must be between {lo} and {hi}")
        return int(v) if integer else float(v)

    out = {
        "scenarioId": cfg.get("scenarioId"),
        "demandIncrease": rng("demandIncrease", 0, 1),
        "reserveDays": rng("reserveDays", 0, 21, integer=True),
        "applyReserve": bool(cfg.get("applyReserve")),
        "additionalDeliveryDelayDays": rng("additionalDeliveryDelayDays", 0, 14, integer=True),
        "deliveryQuantityReduction": rng("deliveryQuantityReduction", 0, 1),
        "planningHorizonDays": rng("planningHorizonDays", 1, 90, integer=True),
        "numberOfRuns": rng("numberOfRuns", 10, 20000, integer=True),
        "randomSeed": rng("randomSeed", 0, 2 ** 32 - 1, integer=True),
        "policyIds": cfg.get("policyIds") or ["lean", "balanced", "resilient"],
    }
    if out["scenarioId"] not in SCENARIOS:
        errors.append(f"Unknown scenario {out['scenarioId']!r}")
    if errors:
        raise ValueError("; ".join(errors))
    return out


def apply(products, cfg):
    """Scenario-adjusted state for each product. Returns new dicts.

    mu_base = mu_hat * seasonal       approved baseline (seasonal adjustment
                                      approved in Step 2, applied once)
    mu      = mu_base * s_D           s_D = 1 + demandIncrease      (3.2)
    alpha   fixed from the approved mean and variance               (4.5)
    L'      = L + delta_L                                           (3.4)
    s_A     = 1 - deliveryQuantityReduction                         (3.4)
    B       = ceil(R * mu_base) when the reserve applies            (3.3)
    """
    s_d = 1.0 + cfg["demandIncrease"]
    s_a = 1.0 - cfg["deliveryQuantityReduction"]
    out = {}
    for pid, p in products.items():
        mu_hat = float(p["dailyDemand"])
        v_hat = p.get("dailyVariance")
        v_hat = mu_hat if v_hat is None else float(v_hat)
        model, alpha = demand_model.choose_model(mu_hat, v_hat)
        seasonal = float(p.get("seasonalMultiplier") or 1.0)
        mu_base = mu_hat * seasonal
        lead = max(1, int(p.get("leadTimeDays") or 1))
        out[pid] = {
            "muHat": mu_hat,
            "vHat": v_hat,
            "model": model,
            "alpha": alpha,
            "seasonalMultiplier": seasonal,
            "muBase": mu_base,
            "mu": mu_base * s_d,
            "demandMultiplier": s_d,
            "leadTime": lead,
            "leadTimeDisrupted": lead + cfg["additionalDeliveryDelayDays"],
            "leadTimeClamped": int(p.get("leadTimeDays") or 0) < 1,
            "supplyMultiplier": s_a,
            "reserveUnits": math.ceil(cfg["reserveDays"] * mu_base) if cfg["applyReserve"] else None,
        }
    return out
