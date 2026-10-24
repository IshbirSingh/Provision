"""Lean, Balanced and Resilient replenishment policies (spec section 5).

Order-up-to targets from quantiles of demand over the protection horizon,
using inventory position (on hand + on order) and optional capacity caps.

Protection horizon h = lead time + order review period, the same convention
for every policy. Lean and Balanced plan on the approved lead time;
Resilient also plans for the scenario's extra delivery delay (spec 5.4).
Targets come from the exact horizon-demand distribution, never from the
Monte Carlo runs being evaluated (spec 5.6).
"""

import numpy as np

import demand_model

POLICY_IDS = ("lean", "balanced", "resilient")
METHOD = "order_up_to_horizon_quantile_v1"

DESCRIPTIONS = {
    "lean": "Orders up to the median of demand over the lead time and order period. Holds the least stock.",
    "balanced": "Orders up to a higher quantile of demand, and to at least the emergency reserve in Safety First.",
    "resilient": "Orders up to a high quantile set by priority, plans for any extra delivery delay and keeps at least the emergency reserve in Safety First.",
}


def targets(states, ids, priorities, review_days, quantiles):
    """Per-policy target T_i, protection horizon h_i and quantile q_i."""
    out = {}
    for policy in POLICY_IDS:
        T, H, Q, reserve_binding = [], [], [], []
        for pid in ids:
            s = states[pid]
            if policy == "resilient":
                h = s["leadTimeDisrupted"] + review_days
                q = quantiles["resilient"][priorities[pid]]
            else:
                h = s["leadTime"] + review_days
                q = quantiles["lean"] if policy == "lean" else quantiles["balanced"]
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
