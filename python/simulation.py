"""Monte Carlo inventory simulation (spec section 6).

Daily time step, seeded runs (1,000 by default) per policy, common random
numbers shared across Lean, Balanced and Resilient.

All runs are simulated together as NumPy arrays. Each product's stock is
held in batch "slots" with a fixed last-usable day: current batches from the
latest count, plus one slot per possible order. Stock is issued
first-expiry-first-out.

Daily order of events (identical for every policy):
  1. scheduled deliveries arrive (a failed delivery arrives as 0)
  2. stock past its date is removed and recorded as waste
  3. on order days, the policy orders max(0, T - inventory position),
     capped by known capacity; it arrives after the actual lead time
  4. demand is sampled (pre-generated) and met FEFO; the rest is unmet
Ordering at the start of a day is equivalent to ordering at the end of the
previous one, and means the day-0 order is the "request now" quantity.
"""

from datetime import date
import hashlib
import time

import numpy as np

import demand_model
import metrics
import policies
import scenario_model

NEVER = 10 ** 9  # last-usable day for stock that does not expire
PRIORITY_RANK = {"critical": 0, "essential": 1, "standard": 2}
METHOD = "daily_fefo_monte_carlo_crn_v1"


def _initial_batches(p, as_of, notes):
    """Current batches as (quantity, last usable day), reconciled with the
    approved current stock."""
    batches = []
    for b in p.get("batches") or []:
        q = int(b["quantity"])
        if q <= 0:
            continue
        day = (date.fromisoformat(b["expiryDate"]) - as_of).days if b.get("expiryDate") else NEVER
        batches.append([q, day])
    batches.sort(key=lambda x: x[1])
    total = sum(q for q, _ in batches)
    stock = int(p["currentStock"])
    if stock > total:
        batches.append([stock - total, NEVER])
        if total:
            notes.append(f"{p['name']}: {stock - total} units of current stock have no date and are treated as not expiring.")
    elif stock < total:
        # Stock has fallen since the count: assume the earliest-dated went first.
        excess = total - stock
        for b in batches:
            take = min(b[0], excess)
            b[0] -= take
            excess -= take
        batches = [b for b in batches if b[0] > 0]
    return batches


def _build_slots(batches, order_days, arrivals, shelf_life):
    """Slots sorted by last usable day. Returns (expiry list, initial qty
    list, slot index of each order)."""
    slots = [(day, 0, k, q) for k, (q, day) in enumerate(batches)]
    for k, (t, a) in enumerate(zip(order_days, arrivals)):
        exp = a + shelf_life - 1 if shelf_life else NEVER
        slots.append((exp, 1, k, 0))
    slots.sort(key=lambda s: (s[0], s[1], s[2]))
    expiry = [s[0] for s in slots]
    init = [s[3] if s[1] == 0 else 0 for s in slots]
    order_slot = [0] * len(order_days)
    for idx, s in enumerate(slots):
        if s[1] == 1:
            order_slot[s[2]] = idx
    return expiry, init, order_slot


def _simulate_policy(T, ctx):
    M, H, N, S, K = ctx["M"], ctx["H"], ctx["N"], ctx["S"], ctx["K"]
    D, success = ctx["D"], ctx["success"]
    slot_exp = ctx["slot_exp"]
    q = np.broadcast_to(ctx["slot_init"], (M, N, S)).copy()
    pend = np.zeros((M, N, K), dtype=np.int64)
    outstanding = np.zeros((M, N), dtype=np.int64)
    unmet = np.zeros((M, N), dtype=np.int64)
    waste = np.zeros((M, N), dtype=np.int64)
    ordered = np.zeros((M, N), dtype=np.int64)
    arrived = np.zeros((M, N), dtype=np.int64)
    fulfilled_total = np.zeros((M, N), dtype=np.int64)
    first_short = np.full((M, N), -1, dtype=np.int64)
    cap_short = np.zeros(N)
    cap_events = np.zeros(N)
    daily = np.zeros((H, M, N), dtype=np.int64)
    util = [[] for _ in ctx["groups"]]
    initial_order = None
    min_stock = 0
    s_a = ctx["s_a"]
    start = q.sum(axis=2)

    for t in range(H):
        # 1. deliveries
        for i, k in ctx["arrivals_by_day"].get(t, []):
            amount = np.floor(pend[:, i, k] * s_a).astype(np.int64) * success[:, i, k]
            q[:, i, ctx["order_slot"][i][k]] += amount
            arrived[:, i] += amount
            outstanding[:, i] -= pend[:, i, k]
        # 2. expiry (last usable day < today)
        expired = slot_exp < t
        if expired.any():
            waste += (q * expired).sum(axis=2)
            q[:, expired] = 0
        # 3. ordering
        if t in ctx["order_index"]:
            k = ctx["order_index"][t]
            position = q.sum(axis=2) + outstanding
            want = policies.order_quantities(T[None, :], position)
            actual = policies.cap_by_capacity(want, position, ctx["groups"], ctx["rank"]) if ctx["groups"] else want
            short = want - actual
            cap_short += short.mean(axis=0)
            cap_events += (short > 0).mean(axis=0)
            pend[:, :, k] = actual
            outstanding += actual
            ordered += actual
            if t == 0:
                initial_order = actual
        # 4. demand, met first-expiry-first-out
        d = D[:, t, :]
        cum = np.cumsum(q, axis=2)
        taken_cum = np.minimum(cum, d[:, :, None])
        taken = np.diff(taken_cum, axis=2, prepend=0)
        q -= taken
        served = taken_cum[:, :, -1]
        u = d - served
        unmet += u
        fulfilled_total += served
        first_short = np.where((first_short < 0) & (u > 0), t, first_short)
        on_hand = q.sum(axis=2)
        daily[t] = on_hand
        min_stock = min(min_stock, int(q.min()))
        for gi, (cap, idx) in enumerate(ctx["groups"]):
            util[gi].append(on_hand[:, idx].sum(axis=1) / cap if cap > 0 else np.zeros(M))

    ending = q.sum(axis=2)
    balance_ok = bool(np.all(start + arrived - fulfilled_total - waste == ending))
    return {
        "unmet": unmet,
        "waste": waste,
        "ordered": ordered,
        "ending": ending,
        "first_short": first_short,
        "initial_order": initial_order if initial_order is not None else np.zeros((M, N), dtype=np.int64),
        "cap_short": cap_short / max(1, K),
        "cap_events": cap_events / max(1, K),
        "daily": daily,
        "orders": pend,
        "util": util,
        "groups": ctx["groups"],
        "checks": {"inventoryNonNegative": min_stock >= 0, "inventoryBalances": balance_ok},
    }


def run(payload):
    started = time.perf_counter()
    cfg = scenario_model.validate(payload["config"])
    g = payload["global"]
    as_of = date.fromisoformat(payload["asOf"])
    products = payload["products"]
    ids = list(products)
    N, M, H = len(ids), cfg["numberOfRuns"], cfg["planningHorizonDays"]
    R = int(g["reviewPeriodDays"])
    p_success = float(g.get("deliverySuccessProbability", 1.0))
    if N == 0:
        raise ValueError("No products to simulate")

    states = scenario_model.apply(products, cfg)
    priorities = {pid: products[pid]["priority"] for pid in ids}
    rank = [PRIORITY_RANK[priorities[pid]] for pid in ids]
    targets = policies.targets(states, ids, priorities, R, H, payload.get("policyLevels"))
    notes = []

    # Order days and actual arrival days (every policy faces the real delay).
    order_days = list(range(0, H, R))
    K = len(order_days)
    arrivals = {pid: [t + states[pid]["leadTimeDisrupted"] for t in order_days] for pid in ids}

    slot_lists = []
    for pid in ids:
        p = products[pid]
        batches = _initial_batches(p, as_of, notes)
        shelf = p.get("shelfLifeDays")
        slot_lists.append(_build_slots(batches, order_days, arrivals[pid], int(shelf) if shelf else None))
    S = max(len(s[0]) for s in slot_lists)
    slot_exp = np.full((N, S), NEVER, dtype=np.int64)
    slot_init = np.zeros((N, S), dtype=np.int64)
    order_slot = []
    for i, (exp, init, oslot) in enumerate(slot_lists):
        slot_exp[i, : len(exp)] = exp
        slot_init[i, : len(init)] = init
        order_slot.append(oslot)

    arrivals_by_day = {}
    for i, pid in enumerate(ids):
        for k, a in enumerate(arrivals[pid]):
            if a < H:
                arrivals_by_day.setdefault(a, []).append((i, k))

    # Capacity per product, derived in Step 2 from storage space (capacity.py).
    caps = g.get("productCapacity") or {}
    groups = []
    group_cats = []
    for i, pid in enumerate(ids):
        if caps.get(pid) is not None:
            groups.append((int(caps[pid]), [i]))
            group_cats.append(pid)

    # Common random numbers: separate seeded streams, generated once.
    demand_seq, delivery_seq = np.random.SeedSequence(cfg["randomSeed"]).spawn(2)
    rng_demand = np.random.default_rng(demand_seq)
    rng_delivery = np.random.default_rng(delivery_seq)
    D = np.empty((M, H, N), dtype=np.int64)
    for i, pid in enumerate(ids):
        s = states[pid]
        D[:, :, i] = demand_model.sample(rng_demand, s["mu"], s["alpha"], (M, H))
    success = (rng_delivery.random((M, N, K)) < p_success).astype(np.int64)
    demand_checksum = hashlib.sha256(D.tobytes()).hexdigest()[:16]

    ctx = {
        "M": M, "H": H, "N": N, "S": S, "K": K, "D": D, "success": success,
        "slot_exp": slot_exp, "slot_init": slot_init, "order_slot": order_slot,
        "order_index": {t: k for k, t in enumerate(order_days)},
        "arrivals_by_day": arrivals_by_day, "groups": groups, "rank": rank,
        "s_a": states[ids[0]]["supplyMultiplier"],
    }

    has_expiry = [bool(products[pid].get("shelfLifeDays")) or any(b.get("expiryDate") for b in products[pid].get("batches") or []) for pid in ids]
    protected = [i for i, pid in enumerate(ids) if priorities[pid] in ("critical", "essential")]
    demand_totals = D.sum(axis=1)  # (M, N)

    raw = {}
    results = {}
    for policy in cfg["policyIds"]:
        T = targets[policy]["target"]
        sim = _simulate_policy(T, ctx)
        raw[policy] = sim
        results[policy] = _summarise(policy, sim, T, targets[policy], ids, products, states, has_expiry, protected, demand_totals, H, group_cats, g, order_days)

    unmet_by_policy = {p: raw[p]["unmet"].sum(axis=1) for p in raw}
    checks = {
        "demandNonNegativeIntegers": bool(D.min() >= 0 and D.dtype.kind == "i"),
        "sameRandomInputsAcrossPolicies": True,  # one D and one delivery draw shared by all policies
        "demandChecksum": demand_checksum,
        "inventoryNonNegative": all(raw[p]["checks"]["inventoryNonNegative"] for p in raw),
        "inventoryBalances": all(raw[p]["checks"]["inventoryBalances"] for p in raw),
        "targetsFromDistributionNotRuns": True,
    }

    return {
        "config": cfg,
        "asOf": as_of.isoformat(),
        "methods": {
            "scenario": scenario_model.METHOD,
            "demandSampling": demand_model.SAMPLING_METHOD,
            "policies": policies.METHOD,
            "simulation": METHOD,
            "metrics": metrics.METHOD,
            "cvar": metrics.CVAR_METHOD,
        },
        "orderDays": order_days,
        "inputs": {
            pid: {
                "muHat": metrics.r(s["muHat"], 4),
                "vHat": metrics.r(s["vHat"], 4),
                "seasonalMultiplier": s["seasonalMultiplier"],
                "muBase": metrics.r(s["muBase"], 4),
                "mu": metrics.r(s["mu"], 4),
                "model": s["model"],
                "alpha": metrics.r(s["alpha"], 6),
                "dailySd": metrics.r(float(np.sqrt(demand_model.daily_variance(s["mu"], s["alpha"]))), 3),
                "leadTime": s["leadTime"],
                "leadTimeDisrupted": s["leadTimeDisrupted"],
                "leadTimeClamped": s["leadTimeClamped"],
                "reserveUnits": s["reserveUnits"],
                "currentStock": int(products[pid]["currentStock"]),
                "expectedDemandHorizon": metrics.r(s["mu"] * H, 1),
                "expectedDemandBeforeFirstDelivery": metrics.r(s["mu"] * s["leadTimeDisrupted"], 1),
                "weeklyCv": metrics.r(float(np.sqrt(demand_model.daily_variance(s["mu"], s["alpha"]) * 7)) / (7 * s["mu"]), 3) if s["mu"] > 0 else None,
                "capacity": None if caps.get(pid) is None else int(caps[pid]),
                "hasExpiryData": has_expiry[i],
            }
            for i, (pid, s) in enumerate((pid, states[pid]) for pid in ids)
        },
        "policies": results,
        "distribution": {"unmetTotal": metrics.histogram(unmet_by_policy)},
        "policyDescriptions": policies.DESCRIPTIONS,
        "policyLevels": {p: targets[p]["level"] for p in cfg["policyIds"]},
        "assumptions": _assumptions(cfg, g, states, ids, products) + notes,
        "checks": checks,
        "runtimeMs": round((time.perf_counter() - started) * 1000),
    }


def _space_use(daily, ids, storage):
    """Peak share of each storage type's space in use, on an average day.
    storage: {"capacityLitres": {type: litres}, "products": {pid: {"type", "volumeL"}}}."""
    if not storage:
        return None
    out = {}
    for stype, litres in (storage.get("capacityLitres") or {}).items():
        if not litres:
            continue
        cols = [i for i, pid in enumerate(ids) if (storage["products"].get(pid) or {}).get("type") == stype]
        if not cols:
            continue
        vol = np.array([storage["products"][ids[i]]["volumeL"] for i in cols], dtype=float)
        used = (daily[:, :, cols] * vol).sum(axis=2)  # (H, M) litres
        out[stype] = {"peak": metrics.r(float(used.mean(axis=1).max()) / litres, 3), "capacityLitres": litres}
    return out or None


def _summarise(policy, sim, T, tg, ids, products, states, has_expiry, protected, demand_totals, H, group_cats, g, order_days):
    M = sim["unmet"].shape[0]
    unmet_total = sim["unmet"].sum(axis=1)
    short_any = sim["unmet"] > 0
    first = sim["first_short"]
    init = sim["initial_order"]
    if not np.all(init == init[0]):
        raise RuntimeError("Day-0 orders differ between runs; they must be deterministic")
    init = init[0]
    daily = sim["daily"]
    orders = sim["orders"]  # (M, N, K)

    prods = {}
    for i, pid in enumerate(ids):
        s = states[pid]
        runs_short = first[:, i] >= 0
        expected_h = s["mu"] * int(tg["horizon"][i])
        first_arrival = s["leadTimeDisrupted"]  # earliest any order can arrive
        prods[pid] = {
            "shortageBeforeFirstDelivery": metrics.r(((first[:, i] >= 0) & (first[:, i] < first_arrival)).mean(), 4),
            "firstPossibleDeliveryDay": int(first_arrival),
            "target": int(T[i]),
            "protectionHorizonDays": int(tg["horizon"][i]),
            "quantile": tg["quantile"][i],
            "reserveBinding": tg["reserveBinding"][i],
            "safetyStock": int(max(0, T[i] - round(expected_h))),
            "initialOrder": int(init[i]),
            "averageOrdered": metrics.r(sim["ordered"][:, i].mean(), 1),
            "expectedUnmet": metrics.r(sim["unmet"][:, i].mean(), 2),
            "unmetP95": int(np.quantile(sim["unmet"][:, i], 0.95)),
            "shortageProbability": metrics.r(short_any[:, i].mean(), 4),
            "medianFirstShortageDay": int(np.median(first[runs_short, i])) if runs_short.any() else None,
            "expectedEnding": metrics.r(sim["ending"][:, i].mean(), 1),
            "expectedWaste": metrics.r(sim["waste"][:, i].mean(), 2) if has_expiry[i] else None,
            "serviceLevel": metrics.r(metrics.service_level(sim["unmet"][:, i], demand_totals[:, i]), 4),
            "simulatedDemandMean": metrics.r(demand_totals[:, i].mean(), 1),
            "capacityShortfallPerOrder": metrics.r(sim["cap_short"][i], 2),
            "capacityLimitedShare": metrics.r(sim["cap_events"][i], 3),
            "riskTarget": tg["riskTarget"][products[pid]["priority"]],
            # Typical order on each order day (expected; re-check before ordering).
            "schedule": [
                {"day": int(t), "mean": metrics.r(float(orders[:, i, k].mean()), 1), "orderedShare": metrics.r(float((orders[:, i, k] > 0).mean()), 3)}
                for k, t in enumerate(order_days)
            ],
            "daily": {
                "mean": [metrics.r(x, 1) for x in daily[:, :, i].mean(axis=1)],
                "p10": [int(x) for x in np.quantile(daily[:, :, i], 0.10, axis=1)],
                "p90": [int(x) for x in np.quantile(daily[:, :, i], 0.90, axis=1)],
            },
        }

    any_protected = short_any[:, protected].any(axis=1) if protected else np.zeros(M, dtype=bool)
    by_priority = {}
    for level in ("critical", "essential", "standard"):
        cols = [i for i, pid in enumerate(ids) if products[pid]["priority"] == level]
        by_priority[level] = metrics.r(short_any[:, cols].any(axis=1).mean(), 4) if cols else None

    waste_cols = [i for i in range(len(ids)) if has_expiry[i]]
    utilisation = {}
    for gi, pid in enumerate(group_cats):
        series = np.stack(sim["util"][gi])
        utilisation[pid] = {"capacity": sim["groups"][gi][0], "average": metrics.r(series.mean(), 3), "max": metrics.r(series.max(), 3)}

    warnings = []
    for i, pid in enumerate(ids):
        if sim["cap_short"][i] > 0 and products[pid]["priority"] in ("critical", "essential"):
            warnings.append(f"Storage space stops this policy reaching its target for {products[pid]['name']} (about {sim['cap_short'][i]:.0f} units short per order).")

    return {
        "totals": {
            "initialOrder": int(init.sum()),
            "averageOrdered": metrics.r(sim["ordered"].sum(axis=1).mean(), 1),
            "expectedUnmet": metrics.r(unmet_total.mean(), 2),
            "unmetCvar95": metrics.r(metrics.cvar(unmet_total, 0.95), 2),
            "unmetP95": int(np.quantile(unmet_total, 0.95)),
            "protectedShortageProbability": metrics.r(any_protected.mean(), 4) if protected else None,
            "expectedProtectedProductsShort": metrics.r(short_any[:, protected].sum(axis=1).mean(), 2) if protected else None,
            "protectedProducts": len(protected),
            "shortageProbabilityByPriority": by_priority,
            "serviceLevel": metrics.r(metrics.service_level(unmet_total, demand_totals.sum(axis=1)), 4),
            "expectedWaste": metrics.r(sim["waste"][:, waste_cols].sum(axis=1).mean(), 2) if waste_cols else None,
            "expectedEnding": metrics.r(sim["ending"].sum(axis=1).mean(), 1),
            "utilisation": utilisation or None,
            "capacityLimitedProducts": [pid for i, pid in enumerate(ids) if sim["cap_events"][i] > 0],
            "spaceUse": _space_use(daily, ids, g.get("storage")),
            "riskTargets": tg["riskTarget"],
            "dailyStock": [metrics.r(x, 1) for x in sim["daily"].sum(axis=2).mean(axis=1)],
        },
        "products": prods,
        "warnings": warnings,
    }


def preview(payload):
    """Policy targets and reserve units for a scenario, without simulating.
    Used by the scenario page to show where a reserve would change targets."""
    cfg = scenario_model.validate({**payload["config"], "applyReserve": False})
    g = payload["global"]
    products = payload["products"]
    ids = list(products)
    states = scenario_model.apply(products, cfg)
    priorities = {pid: products[pid]["priority"] for pid in ids}
    tg = policies.targets(states, ids, priorities, int(g["reviewPeriodDays"]), cfg["planningHorizonDays"])
    return {
        pid: {
            "name": products[pid]["name"],
            "muBase": metrics.r(states[pid]["muBase"], 4),
            "balanced": int(tg["balanced"]["target"][i]),
            "resilient": int(tg["resilient"]["target"][i]),
            # Smallest reserve (days) that would raise each target.
            "bindsFromDays": {
                p: (int(tg[p]["target"][i] // states[pid]["muBase"]) + 1 if states[pid]["muBase"] > 0 else None)
                for p in ("balanced", "resilient")
            },
        }
        for i, pid in enumerate(ids)
    }


def _assumptions(cfg, g, states, ids, products):
    out = [
        f"{cfg['numberOfRuns']:,} simulated futures over {cfg['planningHorizonDays']} days, random seed {cfg['randomSeed']}. All three policies face the same demand and delivery outcomes.",
        "Demand is inferred consumption from stock counts (Step 2), not confirmed demand. Unmet demand while stock was at zero is not in the history.",
        f"Orders can be placed every {g['reviewPeriodDays']} days, starting today. The day-0 order is the quantity to request now.",
        "Stock is issued first-expiry-first-out. Stock past its best-before date is counted as waste.",
        "Every delivery is assumed to arrive in full unless the scenario says otherwise.",
        "Lean and Balanced plan on the approved lead time. Resilient also plans for any extra delivery delay in the scenario. Actual deliveries are delayed for every policy.",
    ]
    if cfg["demandIncrease"] > 0:
        out.append(f"Demand is {cfg['demandIncrease']:.0%} higher than the approved forecast (hypothetical). Holiday and weather adjustments from Step 2 are already in the forecast and are not applied again.")
    if cfg["additionalDeliveryDelayDays"] > 0:
        out.append(f"Every delivery arrives {cfg['additionalDeliveryDelayDays']} day(s) later than the approved lead time (hypothetical).")
    if cfg["deliveryQuantityReduction"] > 0:
        out.append(f"Deliveries bring {cfg['deliveryQuantityReduction']:.0%} less than ordered (hypothetical).")
    if cfg["applyReserve"]:
        out.append(f"Balanced and Resilient keep at least {cfg['reserveDays']} days of average demand as an emergency reserve.")
    H = cfg["planningHorizonDays"]
    late = [products[p]["name"] for p in ids if states[p]["leadTimeDisrupted"] >= H]
    if len(late) == len(ids):
        out.append(f"With these lead times no order can arrive within the {H}-day horizon, so the policies differ only in what they request now; shortages and waste within the horizon come from current stock alone. Lengthen the horizon to see the effect of orders.")
    elif late:
        out.append(f"Orders for {', '.join(late[:5])}{'…' if len(late) > 5 else ''} can't arrive within the {H}-day horizon.")
    if any(states[p]["leadTimeClamped"] for p in ids):
        out.append("Lead times of 0 days are treated as next-day delivery.")
    if not any(v is not None for v in (g.get("productCapacity") or {}).values()):
        out.append("No storage capacity is known, so no storage limit is applied.")
    return out
