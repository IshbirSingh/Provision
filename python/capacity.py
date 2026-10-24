"""Storage capacity per product, derived instead of typed in.

1. Each storage area the food bank entered is converted to litres, kilograms
   or item counts (stated standard sizes for pallets, shelves and crates).
2. Each product has an inferred unit size (volume and weight) and storage
   type (ambient, chilled or frozen), from Nebius or rules.
3. Within each storage type, space is shared between products in proportion
   to the space their consumption takes up: daily demand x unit size, from
   the stock records. Faster-moving and bulkier products get more room.
4. Capacity in product units = allocated space / unit size, and never less
   than the stock already held (which shows the space exists).
"""

import math

METHOD = "consumption_weighted_space_allocation_v1"

# Usable litres per storage unit, and what each assumes.
VOLUME_UNITS = {
    "litres": (1.0, "litres as entered"),
    "m3": (1000.0, "1 m³ = 1,000 litres"),
    "pallets": (1350.0, "a standard UK pallet (1.2 × 1.0 m) stacked to 1.5 m, 75% usable: about 1,350 litres"),
    "shelves": (130.0, "a 1 m shelf, 40 cm deep and 40 cm high, 80% usable: about 130 litres"),
    "crates": (45.0, "a typical stacking crate: about 45 litres usable"),
}


def _area_totals(areas):
    """Total volume (L), weight (kg) and item counts per storage type."""
    totals = {}
    notes = set()
    for a in areas:
        if a.get("capacityEach") is None or not a.get("capacityUnit"):
            continue
        t = totals.setdefault(a["type"], {"litres": 0.0, "kg": 0.0, "units": 0.0, "areas": []})
        amount = float(a["capacityEach"]) * int(a.get("count") or 1)
        unit = a["capacityUnit"]
        if unit in VOLUME_UNITS:
            factor, note = VOLUME_UNITS[unit]
            t["litres"] += amount * factor
            if unit != "litres":
                notes.add(note)
        elif unit == "kg":
            t["kg"] += amount
        elif unit == "units":
            t["units"] += amount
        t["areas"].append(a.get("label") or unit)
    return totals, sorted(notes)


def run(payload):
    areas = payload.get("storageAreas") or []
    products = payload.get("products") or {}
    totals, notes = _area_totals(areas)

    by_type = {}
    for pid, p in products.items():
        by_type.setdefault(p["storageType"], []).append(pid)

    out_products = {}
    out_types = {}
    for stype, ids in by_type.items():
        space = totals.get(stype)
        if not space:
            for pid in ids:
                out_products[pid] = {"capacity": None, "share": None, "reason": f"No {stype} storage capacity was entered, so no limit is applied."}
            out_types[stype] = {"capacityLitres": None, "products": len(ids)}
            continue

        demand = {pid: max(0.0, float(products[pid].get("dailyDemand") or 0.0)) for pid in ids}
        vol = {pid: float(products[pid]["unitVolumeL"]) for pid in ids}
        wt = {pid: float(products[pid]["unitWeightKg"]) for pid in ids}
        vol_need = sum(demand[pid] * vol[pid] for pid in ids)
        wt_need = sum(demand[pid] * wt[pid] for pid in ids)
        unit_need = sum(demand.values())
        stock_litres = sum(products[pid].get("currentStock", 0) * vol[pid] for pid in ids)

        for pid in ids:
            share = demand[pid] * vol[pid] / vol_need if vol_need > 0 else 1.0 / len(ids)
            cap = 0.0
            if space["litres"]:
                cap += share * space["litres"] / vol[pid]
            if space["kg"]:
                w_share = demand[pid] * wt[pid] / wt_need if wt_need > 0 else 1.0 / len(ids)
                cap += w_share * space["kg"] / wt[pid]
            if space["units"]:
                u_share = demand[pid] / unit_need if unit_need > 0 else 1.0 / len(ids)
                cap += u_share * space["units"]
            capacity = int(math.floor(cap))
            stock = int(products[pid].get("currentStock", 0))
            raised = stock > capacity
            out_products[pid] = {
                "capacity": max(capacity, stock),
                "share": round(share, 4),
                "allocatedLitres": round(share * space["litres"], 1) if space["litres"] else None,
                "raisedToCurrentStock": raised,
                "reason": None,
            }
        out_types[stype] = {
            "capacityLitres": round(space["litres"], 1) or None,
            "capacityKg": round(space["kg"], 1) or None,
            "capacityUnits": int(space["units"]) or None,
            "areas": space["areas"],
            "products": len(ids),
            "currentStockLitres": round(stock_litres, 1),
            "currentUse": round(stock_litres / space["litres"], 3) if space["litres"] else None,
        }

    return {"method": METHOD, "products": out_products, "types": out_types, "conversions": notes}
