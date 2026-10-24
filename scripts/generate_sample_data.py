"""Generate the fictional 12-month sample dataset for SupplyShield.

Outputs (fixed seed, so re-running gives identical files):
  data/sample/sample_stock_history.csv  - weekly stock counts as a food bank
                                           might keep them (UK dates, name
                                           variants, notes, a few gaps)
  data/sample/seed.json                 - the same data cleaned into the
                                           data.json schema; used by
                                           "Reset to sample data"

All figures are invented. The dynamics are built so that scenarios and
policies produce visibly different results: seasonal peaks around school
holidays and Christmas, irregular replenishment, short-dated harvest
donations, a missed formula delivery and perishable fresh produce.

Usage: .venv/Scripts/python scripts/generate_sample_data.py
"""

import csv
import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "sample"
SEED = 20261019

FIRST_COUNT = date(2025, 10, 27)  # Monday
WEEKS = 52                        # 52 counts, last on 2026-10-19
COUNT_DATES = [FIRST_COUNT + timedelta(weeks=w) for w in range(WEEKS)]
SNAPSHOT = COUNT_DATES[-1]

CATEGORY_LABELS = {
    "staple_carbohydrates": "Staple carbohydrates",
    "tinned_vegetables": "Tinned vegetables",
    "tinned_protein": "Tinned protein",
    "fresh_produce": "Fresh produce",
    "baby_food_infant_formula": "Baby food / infant formula",
    "hygiene_products": "Hygiene products",
    "allergy_safe_dietary": "Allergy-safe / dietary-specific food",
}

# id, sheet name, category, unit, pack size, pack unit, priority,
# mean weekly demand, NB dispersion (weekly), case size, delivery every n weeks
PRODUCTS = [
    ("pasta_500g", "Pasta 500g", "staple_carbohydrates", "packet", 500, "g", "essential", 95, 0.04, 20, 2),
    ("rice_1kg", "Rice 1kg", "staple_carbohydrates", "bag", 1, "kg", "essential", 60, 0.05, 10, 2),
    ("oats_1kg", "Porridge Oats 1kg", "staple_carbohydrates", "bag", 1, "kg", "essential", 38, 0.06, 12, 2),
    ("peas_tin", "Tinned Peas", "tinned_vegetables", "tin", 300, "g", "essential", 55, 0.05, 24, 2),
    ("sweetcorn_tin", "Tinned Sweetcorn", "tinned_vegetables", "tin", 198, "g", "essential", 44, 0.06, 24, 2),
    ("baked_beans_tin", "Baked Beans 415g", "tinned_protein", "tin", 415, "g", "essential", 120, 0.04, 24, 2),
    ("tuna_tin", "Tinned Tuna", "tinned_protein", "tin", 145, "g", "essential", 48, 0.07, 24, 2),
    ("apples_bag", "Apples (bag)", "fresh_produce", "bag", 6, "apples", "standard", 30, 0.10, 1, 1),
    ("potatoes_2kg", "Potatoes 2.5kg", "fresh_produce", "bag", 2.5, "kg", "standard", 24, 0.10, 1, 1),
    ("infant_formula", "Infant Formula 800g", "baby_food_infant_formula", "tub", 800, "g", "critical", 12, 0.12, 6, 2),
    ("baby_food_jar", "Baby Food Jars", "baby_food_infant_formula", "jar", 125, "g", "critical", 30, 0.10, 12, 2),
    ("toothpaste", "Toothpaste", "hygiene_products", "tube", 75, "ml", "essential", 34, 0.08, 12, 2),
    ("sanitary_pads", "Sanitary Pads", "hygiene_products", "pack", 14, "pads", "essential", 28, 0.08, 12, 2),
    ("gf_pasta_500g", "Gluten Free Pasta 500g", "allergy_safe_dietary", "packet", 500, "g", "critical", 10, 0.15, 6, 2),
    ("lactose_free_milk", "Lactose Free Milk UHT 1L", "allergy_safe_dietary", "carton", 1, "L", "critical", 18, 0.12, 6, 2),
]

CHILD_LINKED = {"pasta_500g", "rice_1kg", "oats_1kg", "baked_beans_tin", "peas_tin", "sweetcorn_tin", "apples_bag"}


def season(week_start, product_id):
    """Fictional demand multiplier for the week starting on `week_start`."""
    d = week_start
    m = 1.0
    if date(2026, 1, 12) <= d <= date(2026, 2, 23):
        m = 1.12  # winter heating costs
    windows = [
        (date(2025, 10, 27), date(2025, 10, 31), 1.10),  # October half-term
        (date(2025, 12, 8), date(2025, 12, 21), 1.25),   # run-up to Christmas
        (date(2025, 12, 22), date(2026, 1, 4), 1.40),    # Christmas holidays
        (date(2026, 1, 5), date(2026, 1, 11), 1.20),
        (date(2026, 2, 16), date(2026, 2, 20), 1.20),    # February half-term
        (date(2026, 3, 30), date(2026, 4, 10), 1.18),    # Easter holidays
        (date(2026, 5, 25), date(2026, 5, 29), 1.10),    # May half-term
        (date(2026, 7, 20), date(2026, 9, 1), 1.25),     # summer holidays
    ]
    for start, end, mult in windows:
        if start <= d <= end or start <= d + timedelta(days=6) <= end:
            m = mult
    # School-holiday effects are weaker for baby and hygiene items.
    if product_id not in CHILD_LINKED:
        m = 1 + (m - 1) * 0.4
    return m


def nb(rng, mean, alpha):
    """Negative binomial draw with mean `mean` and Var = mean + alpha*mean^2."""
    if alpha <= 0:
        return int(rng.poisson(mean))
    return int(rng.poisson(rng.gamma(1 / alpha, alpha * mean)))


def simulate_product(rng, spec):
    pid, _, category, _, _, _, _, base, alpha, case, every = spec
    stock = int(base * 3.4)
    target = int(base * 4.6)
    history = []           # (count_date, stock, note)
    pending = []           # (arrival_week, qty)

    for w, count_date in enumerate(COUNT_DATES):
        note = ""
        if w == 0:
            history.append((count_date, stock, note))
            continue

        week_start = COUNT_DATES[w - 1]
        arrivals = sum(q for (aw, q) in pending if aw == w)
        pending = [(aw, q) for (aw, q) in pending if aw != w]

        # Supermarket surplus for fresh produce arrives most weeks.
        if category == "fresh_produce":
            arrivals += int(rng.poisson(base * 1.4)) if rng.random() < 0.92 else 0

        # Harvest festival and Christmas collections (mostly tins and dry goods).
        if category in {"tinned_vegetables", "tinned_protein", "staple_carbohydrates"}:
            if count_date in (date(2025, 11, 3), date(2026, 10, 12)):
                arrivals += int(base * rng.uniform(1.4, 2.0))
                note = "harvest festival donations"
            if count_date == date(2025, 12, 15):
                arrivals += int(base * rng.uniform(1.0, 1.5))
                note = "christmas collection"

        demand = nb(rng, base * season(week_start, pid), alpha)
        available = stock + arrivals
        consumed = min(available, demand)
        stock = available - consumed

        # Fresh produce spoils; some is binned each week.
        if category == "fresh_produce" and stock > 0:
            stock -= int(rng.binomial(stock, 0.18))

        # Planned order for the next delivery cycle (not every week).
        if category != "fresh_produce" and w % every == 0:
            position = stock + sum(q for _, q in pending)
            if position < target:
                qty = int(np.ceil((target - position) / case) * case)
                lead = 1
                if rng.random() < 0.15:
                    lead += 1  # delivery a week late
                if rng.random() < 0.10:
                    qty = int(qty * 0.6)  # short delivery
                # The last formula and lactose-free orders are not delivered.
                if pid in {"infant_formula", "lactose_free_milk"} and w >= WEEKS - 4:
                    qty = 0
                if qty > 0:
                    pending.append((w + lead, qty))

        history.append((count_date, stock, note))
    return history


def add_irregular_events(histories):
    """Decreases that are not demand: a transfer and a stock-take correction."""
    beans = histories["baked_beans_tin"]
    i = 20
    d, q, _ = beans[i]
    beans[i] = (d, max(0, q - 60), "transfer to St Mark's pantry")
    for j in range(i + 1, len(beans)):
        d, q, n = beans[j]
        beans[j] = (d, max(0, q - 60), n)

    rice = histories["rice_1kg"]
    d, q, _ = rice[33]
    rice[33] = (d, max(0, q - 25), "stock take corrected")
    for j in range(34, len(rice)):
        d, q, n = rice[j]
        rice[j] = (d, max(0, q - 25), n)


def batches_for(pid, total):
    """Split the final count into batches with best-before dates."""
    d = lambda y, m, dd: date(y, m, dd).isoformat()
    plans = {
        "pasta_500g": [(0.3, d(2026, 12, 1)), (0.7, d(2027, 9, 30))],
        "rice_1kg": [(1.0, d(2027, 11, 30))],
        "oats_1kg": [(0.5, d(2027, 2, 28)), (0.5, d(2027, 6, 30))],
        "peas_tin": [(1.0, d(2028, 3, 31))],
        "sweetcorn_tin": [(0.4, d(2027, 1, 31)), (0.6, d(2028, 5, 31))],
        "baked_beans_tin": [(0.45, d(2026, 11, 6)), (0.55, d(2027, 8, 14))],
        "tuna_tin": [(1.0, d(2029, 1, 31))],
        "apples_bag": [(0.6, d(2026, 10, 27)), (0.4, d(2026, 10, 31))],
        "potatoes_2kg": [(1.0, d(2026, 11, 2))],
        "infant_formula": [(1.0, d(2027, 5, 31))],
        "baby_food_jar": [(0.5, d(2026, 11, 15)), (0.5, d(2027, 4, 30))],
        "toothpaste": [(1.0, None)],
        "sanitary_pads": [(1.0, None)],
        "gf_pasta_500g": [(1.0, d(2027, 3, 31))],
        "lactose_free_milk": [(1.0, d(2026, 12, 20))],
    }
    if total == 0:
        return [(0, None)]  # still record the zero count
    out, remaining = [], total
    plan = plans[pid]
    for k, (share, expiry) in enumerate(plan):
        qty = remaining if k == len(plan) - 1 else int(round(total * share))
        remaining -= qty
        if qty > 0:
            out.append((qty, expiry))
    return out


def uk(d):
    return d.strftime("%d/%m/%Y")


def main():
    rng = np.random.default_rng(SEED)
    histories = {spec[0]: simulate_product(rng, spec) for spec in PRODUCTS}
    add_irregular_events(histories)

    spec_by_id = {s[0]: s for s in PRODUCTS}
    rows, seed_history, seed_inventory = [], {}, {}
    rec_n = 0
    batch_n = 0

    for pid, history in histories.items():
        _, sheet_name, category, unit, *_ = spec_by_id[pid]
        for w, (count_date, qty, note) in enumerate(history):
            name = sheet_name
            # Inconsistent naming, as typed by different volunteers.
            if w % 9 == 4:
                name = sheet_name.lower()
            if pid == "pasta_500g" and w % 11 == 7:
                name = "Pasta (500g)"
            if pid == "baked_beans_tin" and w in (15, 16):
                name = "Beans - baked"

            cat_label = CATEGORY_LABELS[category] if w % 6 != 3 else ""
            is_last = count_date == SNAPSHOT

            # A few missing or approximate counts.
            qty_text = str(qty)
            missing = (pid == "tuna_tin" and w == 27) or (pid == "oats_1kg" and w == 40)
            approx = pid == "sweetcorn_tin" and w == 18
            if missing:
                qty_text = ""
                note = "not counted"
            elif approx:
                qty_text = f"approx {qty}"

            if is_last:
                for bqty, expiry in batches_for(pid, qty):
                    rows.append([uk(count_date), name, cat_label, bqty, unit, uk(date.fromisoformat(expiry)) if expiry else "", note])
                    batch_n += 1
                    seed_inventory[f"batch_{batch_n:03d}"] = {
                        "productId": pid,
                        "quantity": bqty,
                        "snapshotDate": SNAPSHOT.isoformat(),
                        "expiryDate": expiry,
                        "expiryType": "best_before" if expiry else None,
                    }
            else:
                rows.append([uk(count_date), name, cat_label, qty_text, unit, "", note])

            if not missing:
                rec_n += 1
                seed_history[f"record_{rec_n:04d}"] = {
                    "productId": pid,
                    "date": count_date.isoformat(),
                    "quantity": qty,
                    "unit": unit,
                    "note": note or None,
                    "source": "sample_dataset",
                }

    # Sheet order: by count date, then item - as a stock-take log would be.
    rows.sort(key=lambda r: (r[0][6:] + r[0][3:5] + r[0][:2], r[1].lower()))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "sample_stock_history.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Date Counted", "Item", "Category", "Qty", "Unit", "Best Before", "Notes"])
        writer.writerows(rows)

    products = {
        pid: {
            "name": sheet_name,
            "category": category,
            "unit": unit,
            "packSize": pack,
            "packSizeUnit": pack_unit,
            "priority": priority,
            "unitCost": None,
        }
        for pid, sheet_name, category, unit, pack, pack_unit, priority, *_ in PRODUCTS
    }
    seed = {
        "products": products,
        "historicalStock": seed_history,
        "inventory": seed_inventory,
        "staging": {
            "sourceFile": "sample_stock_history.csv",
            "extractedAt": None,
            "columnMapping": {},
            "records": {},
            "warnings": {},
        },
    }
    with open(OUT_DIR / "seed.json", "w", encoding="utf-8") as f:
        json.dump(seed, f, indent=2)

    print(f"{len(rows)} CSV rows, {len(products)} products, {len(seed_history)} records, {len(seed_inventory)} batches")


if __name__ == "__main__":
    main()
