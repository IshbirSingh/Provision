"""Step 2: historical analysis of approved stock records.

Infers consumption (inventory decreases), replenishment events (increases),
variability, trends, holiday and monthly patterns, and expiry risk.
Decreases are labelled as inferred consumption, not confirmed demand.

Interval rules, for each pair of consecutive counts:
  - notes mention a transfer, correction or waste -> excluded (not demand)
  - stock rose                                    -> replenishment; consumption
                                                     in that interval is unobserved
  - stock fell to zero                            -> censored (demand may have
                                                     been higher); excluded unless
                                                     too few other intervals remain
  - stock fell                                    -> inferred consumption
  - unchanged                                     -> ambiguous; not used
"""

from datetime import date, timedelta
import math

import numpy as np
from scipy import stats

import demand_model

NOT_DEMAND = {"transfer", "correction", "waste"}
MIN_INTERVALS = 3
FEW_INTERVALS = 8
TREND_P = 0.05
SEASON_P = 0.10

METHODS = {
    "consumption": "net_fall_intervals_v1",
    "demand": demand_model.ESTIMATE_METHOD,
    "dispersion": demand_model.DISPERSION_METHOD,
    "seasonality": "holiday_term_rate_ratio_welch_v1",
    "trend": "ols_daily_rate_v1",
    "supply": "rise_intervals_v1",
    "expiry": "fefo_expected_unused_v1",
}


def d(s):
    return date.fromisoformat(s)


def overlap_days(start, end, ranges):
    """Days in [start, end) that fall inside any (start, end inclusive) range."""
    total = 0
    for r_start, r_end in ranges:
        lo = max(start, r_start)
        hi = min(end, r_end + timedelta(days=1))
        if hi > lo:
            total += (hi - lo).days
    return total


def r(x, n=3):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), n)


def classify_intervals(series):
    out = []
    for k in range(1, len(series)):
        prev, cur = series[k - 1], series[k]
        length = (cur["date"] - prev["date"]).days
        delta = cur["quantity"] - prev["quantity"]
        hints = set(cur.get("movementHints") or [])
        iv = {
            "start": prev["date"].isoformat(),
            "end": cur["date"].isoformat(),
            "days": length,
            "change": delta,
            "approximate": bool(prev.get("approximate") or cur.get("approximate")),
        }
        if length <= 0:
            iv["type"] = "invalid"
        elif hints & NOT_DEMAND:
            iv["type"] = "excluded"
            iv["reason"] = ", ".join(sorted(hints & NOT_DEMAND))
        elif delta > 0:
            iv["type"] = "rise"
        elif delta < 0 and cur["quantity"] == 0:
            iv["type"] = "censored"
        elif delta < 0:
            iv["type"] = "fall"
        else:
            iv["type"] = "unchanged"
        out.append(iv)
    return out


def demand_estimate(intervals):
    falls = [iv for iv in intervals if iv["type"] == "fall"]
    censored = [iv for iv in intervals if iv["type"] == "censored"]
    used = falls
    fallback = None
    if len(falls) < MIN_INTERVALS and censored:
        used = falls + censored
        fallback = "censored_included"
    if len(used) < 2:
        return {"available": False, "intervalsUsed": len(used), "fallback": "insufficient_intervals"}, used

    consumption = [-iv["change"] for iv in used]
    lengths = [iv["days"] for iv in used]
    mu, v = demand_model.estimate_daily(consumption, lengths)
    model, alpha = demand_model.choose_model(mu, v)
    model_var = demand_model.daily_variance(mu, alpha)
    ci = demand_model.normal_ci(mu, v, sum(lengths))
    return {
        "available": True,
        "label": "inferred consumption",
        "dailyMean": r(mu, 4),
        "dailyVariance": r(v, 4),
        "dispersionAlpha": r(alpha, 6),
        "model": model,
        "weeklyMean": r(7 * mu, 2),
        "weeklySd": r(math.sqrt(7 * model_var), 2),
        "weeklyCi95": [r(7 * ci[0], 2), r(7 * ci[1], 2)] if ci else None,
        "intervalsUsed": len(used),
        "daysObserved": int(sum(lengths)),
        "fallback": fallback,
    }, used


def seasonality(used, holidays, mu, as_of, horizon_days):
    ranges = [(d(h["start"]), d(h["end"])) for h in holidays]
    hol, term = [], []
    monthly = {}
    for iv in used:
        start, end = d(iv["start"]), d(iv["end"])
        rate = -iv["change"] / iv["days"]
        frac = overlap_days(start, end, ranges) / iv["days"]
        (hol if frac >= 0.5 else term).append(rate)
        mid = start + (end - start) / 2
        monthly.setdefault(mid.month, []).append(rate)

    horizon_end = as_of + timedelta(days=horizon_days)
    horizon_frac = overlap_days(as_of, horizon_end, ranges) / horizon_days if horizon_days else 0.0
    result = {
        "monthlyRatio": {str(m): r(np.mean(v) / mu, 3) for m, v in sorted(monthly.items())} if mu else {},
        "holidayIntervals": len(hol),
        "termIntervals": len(term),
        "holidayRatio": None,
        "pValue": None,
        "significant": False,
        "horizonHolidayShare": r(horizon_frac, 3),
        "suggestedMultiplier": 1.0,
        "reason": None,
    }
    if len(hol) < 3 or len(term) < 3 or not mu:
        result["reason"] = "Not enough counts in and out of school holidays to compare."
        return result

    hol_mean, term_mean = float(np.mean(hol)), float(np.mean(term))
    result["holidayRatio"] = r(hol_mean / term_mean, 3) if term_mean > 0 else None
    p = float(stats.ttest_ind(hol, term, equal_var=False).pvalue)
    result["pValue"] = r(p, 4)
    result["significant"] = p < SEASON_P
    if not result["significant"]:
        result["reason"] = f"Holiday and term-time consumption are not clearly different (p = {p:.2f}), so no adjustment is suggested."
        return result

    # Expected rate over the horizon relative to the all-year mean, so the
    # adjustment is applied once and not on top of an already-mixed mean.
    expected = term_mean * (1 - horizon_frac) + hol_mean * horizon_frac
    result["suggestedMultiplier"] = r(expected / mu, 3)
    share = round(horizon_frac * 100)
    result["reason"] = (
        f"Consumption in school holidays averaged {hol_mean / term_mean:.2f}x term time (p = {p:.3f}). "
        f"{share}% of the planning horizon falls in a holiday."
    )
    return result


def trend(used):
    if len(used) < 6:
        return {"available": False}
    t0 = d(used[0]["start"])
    x = [((d(iv["start"]) - t0).days + iv["days"] / 2) / 7 for iv in used]
    y = [-iv["change"] / iv["days"] for iv in used]
    fit = stats.linregress(x, y)
    mean = float(np.mean(y))
    pct_month = fit.slope * 4.345 / mean * 100 if mean > 0 else None
    return {
        "available": True,
        "slopePerWeek": r(fit.slope, 5),
        "percentPerMonth": r(pct_month, 2),
        "pValue": r(float(fit.pvalue), 4),
        "significant": bool(fit.pvalue < TREND_P),
    }


def weekday_pattern(series, intervals):
    days = [iv["days"] for iv in intervals if iv["days"] > 0]
    if not days or float(np.median(days)) > 1.5:
        return {"available": False, "reason": "Counts are not daily, so weekday patterns can't be measured."}
    rates = {}
    for iv in intervals:
        if iv["type"] == "fall" and iv["days"] == 1:
            rates.setdefault(d(iv["end"]).weekday(), []).append(-iv["change"])
    overall = np.mean([x for v in rates.values() for x in v]) if rates else None
    if not overall:
        return {"available": False, "reason": "Not enough daily falls to compare weekdays."}
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    return {"available": True, "ratio": {names[k]: r(np.mean(v) / overall, 3) for k, v in sorted(rates.items())}}


def supply(intervals, mu):
    rises = [iv for iv in intervals if iv["type"] == "rise"]
    total_days = sum(iv["days"] for iv in intervals if iv["days"] > 0)
    out = {
        "rises": len(rises),
        "risingShare": r(len(rises) / len(intervals), 3) if intervals else None,
        "risesPer28Days": r(len(rises) / total_days * 28, 2) if total_days else None,
        "medianDaysBetweenRises": None,
        "medianRise": int(np.median([iv["change"] for iv in rises])) if rises else None,
        "estimatedDeliverySize": None,
        "regularity": "insufficient",
        "reliability": None,
        "note": "Delivery reliability can't be measured from stock counts. It needs scheduled delivery records.",
    }
    if mu and rises:
        out["estimatedDeliverySize"] = int(np.median([iv["change"] + mu * iv["days"] for iv in rises]))
    if len(rises) >= 3:
        ends = [d(iv["end"]) for iv in rises]
        gaps = [(b - a).days for a, b in zip(ends, ends[1:])]
        out["medianDaysBetweenRises"] = float(np.median(gaps))
        cv = float(np.std(gaps) / np.mean(gaps)) if np.mean(gaps) > 0 else None
        out["regularity"] = "regular" if cv is not None and cv < 0.35 else "irregular"
    return out


def expiry(batches, mu, as_of, snapshot, horizon_days):
    """Expected units left when each batch reaches its date, if stock is used
    first-expiry-first-out at the average daily rate. A simple expectation;
    the Step 4 simulation gives the full distribution."""
    dated = sorted([b for b in batches if b.get("expiryDate")], key=lambda b: b["expiryDate"])
    undated = sum(b["quantity"] for b in batches if not b.get("expiryDate"))
    rows = []
    consumed = 0.0
    window = max(horizon_days, 30)
    for b in dated:
        exp = d(b["expiryDate"])
        days_from_count = (exp - snapshot).days
        days_to_expiry = (exp - as_of).days
        used = 0.0
        if mu:
            used = min(b["quantity"], max(0.0, mu * max(days_from_count, 0) - consumed))
            consumed += used
        unused = b["quantity"] - used if mu else None
        rows.append({
            "quantity": b["quantity"],
            "expiryDate": b["expiryDate"],
            "expiryType": b.get("expiryType"),
            "daysToExpiry": days_to_expiry,
            "expectedUnused": None if unused is None else int(round(unused)),
            "atRisk": bool(unused is not None and unused > 0 and days_to_expiry <= window),
            "pastDate": days_to_expiry < 0,
        })
    at_risk = [x for x in rows if x["atRisk"]]
    return {
        "batches": rows,
        "undatedQuantity": undated,
        "batchesWithExpiry": len(dated),
        "earliestExpiry": dated[0]["expiryDate"] if dated else None,
        "expectedUnusedUnits": int(sum(x["expectedUnused"] or 0 for x in rows if x["atRisk"])) if mu else None,
        "atRiskBatches": len(at_risk),
    }


def analyse_product(pid, product, records, batches, holidays, as_of, horizon_days):
    series = sorted(
        ({**rec, "date": d(rec["date"])} for rec in records),
        key=lambda x: x["date"],
    )
    intervals = classify_intervals(series)
    demand, used = demand_estimate(intervals)
    mu = demand.get("dailyMean")
    snapshot = series[-1]["date"] if series else None
    current = sum(b["quantity"] for b in batches) if batches else (series[-1]["quantity"] if series else 0)

    counts = {t: sum(1 for iv in intervals if iv["type"] == t) for t in ("fall", "rise", "censored", "excluded", "unchanged")}
    lengths = [iv["days"] for iv in intervals if iv["days"] > 0]
    typical = float(np.median(lengths)) if lengths else None
    gaps = [iv for iv in intervals if typical and iv["days"] > 1.5 * typical]

    flags = []

    def flag(level, code, message):
        flags.append({"level": level, "code": code, "message": message})

    flag("info", "inferred", "Demand is inferred from falls in stock between counts. Deliveries during an interval hide part of that interval's consumption, so this may understate demand.")
    if not demand["available"]:
        flag("warning", "no_estimate", "Too few falls in stock to estimate demand. Enter an estimate below.")
    elif demand["intervalsUsed"] < FEW_INTERVALS:
        flag("warning", "few_intervals", f"Only {demand['intervalsUsed']} intervals could be used, so this estimate is uncertain.")
    if demand.get("fallback") == "censored_included":
        flag("warning", "censored_used", "Intervals that ended at zero stock were included because few others were available; real demand was probably higher.")
    if counts["censored"]:
        flag("warning", "stockouts", f"Stock ran out {counts['censored']} time(s). Demand while empty isn't recorded, so true demand may be higher.")
    if intervals and counts["rise"] / len(intervals) > 0.6:
        flag("warning", "mostly_rises", f"Stock rose in {counts['rise']} of {len(intervals)} intervals, so most consumption is hidden by deliveries. Treat this estimate with caution.")
    if product.get("category") == "fresh_produce" and demand["available"]:
        flag("warning", "fresh_hidden", "Fresh produce often arrives in small, frequent deliveries that weekly counts don't show, so inferred consumption is likely to be too low. Check it against distribution records if you have them.")
    if counts["excluded"]:
        flag("info", "excluded_movements", f"{counts['excluded']} interval(s) were left out because notes mention a transfer, correction or waste.")
    if any(iv["approximate"] for iv in intervals):
        flag("info", "approximate", "Some counts were recorded as approximate.")
    if gaps:
        flag("info", "gaps", f"{len(gaps)} gap(s) between counts were longer than usual.")
    if snapshot and (as_of - snapshot).days > 7:
        flag("warning", "stale_count", f"The latest count is {(as_of - snapshot).days} days old. Current stock may have changed.")

    season = seasonality(used, holidays, mu, as_of, horizon_days) if demand["available"] else {"suggestedMultiplier": 1.0, "reason": "No demand estimate."}
    exp = expiry(batches, mu, as_of, snapshot or as_of, horizon_days)
    if exp["atRiskBatches"]:
        flag("warning", "expiry_risk", f"{exp['atRiskBatches']} batch(es) may not be used before their date at the usual rate. Distribute these first.")

    return {
        "productId": pid,
        "observations": {
            "counts": len(series),
            "from": series[0]["date"].isoformat() if series else None,
            "to": snapshot.isoformat() if snapshot else None,
            "typicalIntervalDays": typical,
            "intervals": len(intervals),
            "byType": counts,
            "excluded": [{"end": iv["end"], "reason": iv["reason"]} for iv in intervals if iv["type"] == "excluded"],
            "longGaps": len(gaps),
        },
        "demand": demand,
        "trend": trend(used) if demand["available"] else {"available": False},
        "seasonality": season,
        "weekday": weekday_pattern(series, intervals),
        "supply": supply(intervals, mu),
        "stock": {
            "current": int(current),
            "snapshotDate": snapshot.isoformat() if snapshot else None,
            "daysSinceCount": (as_of - snapshot).days if snapshot else None,
            "daysOfCover": r(current / mu, 1) if mu else None,
        },
        "expiry": exp,
        "flags": flags,
        "chart": {
            "dates": [x["date"].isoformat() for x in series],
            "stock": [int(x["quantity"]) for x in series],
            "types": [None] + [iv["type"] for iv in intervals],
        },
    }


def run(payload):
    as_of = d(payload["asOf"])
    horizon = int(payload.get("horizonDays") or 7)
    holidays = payload.get("holidays") or []
    by_product = {}
    for rec in payload.get("records", []):
        by_product.setdefault(rec["productId"], []).append(rec)
    batches = {}
    for b in payload.get("batches", []):
        batches.setdefault(b["productId"], []).append(b)

    products = {
        pid: analyse_product(pid, p, by_product.get(pid, []), batches.get(pid, []), holidays, as_of, horizon)
        for pid, p in payload.get("products", {}).items()
    }
    return {
        "asOf": as_of.isoformat(),
        "horizonDays": horizon,
        "methods": METHODS,
        "assumptions": [
            "Counts are snapshots; the change between two counts is deliveries minus consumption, waste and transfers.",
            "Interval totals are treated as sums of independent daily demands to convert to daily figures.",
            "School holiday dates are typical England dates unless your local dates are entered.",
        ],
        "products": products,
    }
