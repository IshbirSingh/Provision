"""Lean, Balanced and Resilient replenishment policies (spec section 5).

Order-up-to targets from quantiles of demand over the protection horizon,
using inventory position (on hand + on order) and optional capacity caps.

Each policy aims for a chance of running out over the whole planning
horizon (Lean about 40%, Balanced 25%, Resilient 5-10% by priority). With
k order cycles in the horizon, a per-cycle quantile q gives roughly
P(no shortage) = q^k, so q = (1 - P)^(1/k).

Protection horizon h = lead time + order review period, the same convention
for every policy. Lean and Balanced plan on the approved lead time;
Resilient also plans for the scenario's extra delivery delay (spec 5.4).
Targets come from the exact horizon-demand distribution, never from the
Monte Carlo runs being evaluated (spec 5.6).
"""

import math

import numpy as np

import demand_model

POLICY_IDS = ("lean", "balanced", "resilient")
METHOD = "order_up_to_horizon_risk_target_v2"

# Target chance of running out at least once over the planning horizon.
RISK_TARGETS = {
    "lean": 0.40,
    "balanced": 0.25,
    "resilient": {"critical": 0.05, "essential": 0.08, "standard": 0.10},
}

DESCRIPTIONS = {
    "lean": "Holds the least stock. Aims for about a 40% chance of running out over the plan.",
    "balanced": "Aims for about a 25% chance of running out over the plan.",
    "resilient": "Holds the most stock and plans for late deliveries. Aims for 5-10% depending on priority.",
}


def risk_targets_for(policy, level=None):
    """Target horizon shortage chance per priority. `level` fine-tunes a
    policy as a protection level (1 - chance of running out): for Lean and
    Balanced it applies to every product; for Resilient it is the critical
    level, with essential and standard moved by the same amount."""
    if policy == "resilient":
        base = dict(RISK_TARGETS["resilient"])
        if level is not None:
            shift = (1 - level) - base["critical"]
            base = {k: min(0.5, max(0.005, v + shift)) for k, v in base.items()}
        return base
    p = RISK_TARGETS[policy] if level is None else 1 - level
    return {"critical": p, "essential": p, "standard": p}


def cycle_quantile(risk, cycles):
    """Per-cycle quantile giving roughly `risk` chance of a shortage over
    `cycles` independent order cycles."""
    return min(0.9995, (1 - risk) ** (1 / max(1, cycles)))


def targets(states, ids, priorities, review_days, horizon_days, levels=None):
    """Per-policy target T_i, protection horizon h_i and quantile q_i.
    `levels` optionally fine-tunes one or more policies (see risk_targets_for)."""
    levels = levels or {}
    cycles = math.ceil(horizon_days / review_days)
    out = {}
    for policy in POLICY_IDS:
        risks = risk_targets_for(policy, levels.get(policy))
        T, H, Q, reserve_binding = [], [], [], []
        for pid in ids:
            s = states[pid]
            q = cycle_quantile(risks[priorities[pid]], cycles)
            if policy == "resilient":
                h = s["leadTimeDisrupted"] + review_days
            else:
                h = s["leadTime"] + review_days
            t = demand_model.horizon_quantile(s["mu"], s["alpha"], h, q)
            binding = False
            if policy != "lean" and s["reserveUnits"] is not None and s["reserveUnits"] > t:
                t, binding = s["reserveUnits"], True
            T.append(t)
            H.append(h)
            Q.append(q)
            reserve_binding.append(binding)
        out[policy] = {
            "target": np.array(T, dtype=np.int64),
            "horizon": np.array(H, dtype=np.int64),
            "quantile": Q,
            "reserveBinding": reserve_binding,
            "riskTarget": risks,
            "level": {k: round(1 - v, 4) for k, v in risks.items()},
            "cycles": cycles,
            "fineTuned": policy in levels,
        }
    return out


def order_quantities(target, position):
    """Q = max(0, T - IP)  (spec 5.2-5.4). Shapes broadcast over runs."""
    return np.maximum(0, target - position)


def cap_by_capacity(want, position, groups, rank):
    """Cap orders so each capacity group stays within its limit (spec 5.5).

    want, position: (M, N). groups: list of (capacity, product indices).
    When a group's headroom is short, critical products are filled first,
    then essential, then standard; within a level, headroom is shared in
    proportion to the shortfall. Returns the capped orders.
    """
    actual = want.copy()
    for capacity, idx in groups:
        idx = np.asarray(idx)
        headroom = np.maximum(0, capacity - position[:, idx].sum(axis=1))
        remaining = headroom.astype(float)
        capped = np.zeros_like(want[:, idx])
        for level in sorted(set(rank[i] for i in idx)):
            cols = np.array([k for k, i in enumerate(idx) if rank[i] == level])
            w = want[:, idx][:, cols].astype(float)
            total = w.sum(axis=1)
            share = np.where(total > 0, np.minimum(1.0, remaining / np.where(total > 0, total, 1)), 0.0)
            give = np.floor(w * share[:, None]).astype(np.int64)
            capped[:, cols] = give
            remaining -= give.sum(axis=1)
        actual[:, idx] = capped
    return actual
