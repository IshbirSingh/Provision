"""Step 2: historical analysis of approved stock records.

Infers consumption (inventory decreases), replenishment events (increases),
variability, a trend, the effect of school holidays and temperature, and
expiry risk. Decreases are labelled as inferred consumption, not confirmed
demand.

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
EFFECT_P = 0.05          # an effect is applied only when the data shows it clearly
MIN_ADJUSTMENT_INTERVALS = 10
ADJUSTMENT_LIMITS = (0.7, 1.4)

METHODS = {
    "consumption": "net_fall_intervals_v1",
    "demand": demand_model.ESTIMATE_METHOD,
    "dispersion": demand_model.DISPERSION_METHOD,
    "adjustment": "wls_holiday_temperature_v1",
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
        "unitsObserved": int(sum(consumption)),
        "daysObserved": int(sum(lengths)),
        "fallback": fallback,
    }, used


def _interval_temperature(iv, temps):
    start, end = d(iv["start"]), d(iv["end"])
    values = [temps.get((start + timedelta(days=k)).isoformat()) for k in range((end - start).days)]
    values = [x for x in values if x is not None]
    return float(np.mean(values)) if len(values) >= max(1, 0.7 * (end - start).days) else None


def _wls(X, y, w):
    """Weighted least squares with coefficient p-values."""
    W = np.sqrt(w)
    Xw, yw = X * W[:, None], y * W
    beta, *_ = np.linalg.lstsq(Xw, yw, rcond=None)
    resid = yw - Xw @ beta
    dof = len(y) - X.shape[1]
    if dof <= 0:
        return beta, np.ones(len(beta))
    sigma2 = float(resid @ resid) / dof
    try:
        cov = sigma2 * np.linalg.inv(Xw.T @ Xw)
    except np.linalg.LinAlgError:
        return beta, np.ones(len(beta))
    se = np.sqrt(np.maximum(np.diag(cov), 1e-12))
    p = 2 * stats.t.sf(np.abs(beta / se), dof)
    return beta, p


def adjustment(used, holidays, weather, mu, as_of, horizon_days):
    """Forecast adjustment from school holidays and temperature.

    Daily consumption in each interval is modelled, weighted by interval
    length, as
        rate = b0 + b_h * (holiday share) + b_t * (temperature - average)
    using only this product's own records. A term is kept only if the data
    shows it clearly; both are estimated together so neither is counted
    twice. The adjustment is the predicted rate for the planning horizon
    divided by the average rate over the records.
    """
    ranges = [(d(h["start"]), d(h["end"])) for h in holidays]
    temps = (weather or {}).get("history") or {}
    horizon_temps = [t for t in ((weather or {}).get("horizon") or []) if t is not None]
    horizon_end = as_of + timedelta(days=horizon_days)
    horizon_share = overlap_days(as_of, horizon_end, ranges) / horizon_days if horizon_days else 0.0

    out = {
        "multiplier": 1.0,
        "holiday": {"applied": False, "horizonShare": r(horizon_share, 3), "effect": None, "contribution": 0.0},
        "weather": {"available": bool(temps), "applied": False, "perDegree": None, "recordsMeanTemp": None,
                    "horizonMeanTemp": r(float(np.mean(horizon_temps)), 1) if horizon_temps else None, "contribution": 0.0},
        "explanation": [],
    }
    if not mu or len(used) < MIN_ADJUSTMENT_INTERVALS:
        out["explanation"].append("Not enough counts to measure the effect of holidays or weather, so no adjustment is made.")
        return out

    rows = []
    for iv in used:
        start, end = d(iv["start"]), d(iv["end"])
        rows.append({
            "rate": -iv["change"] / iv["days"],
            "days": iv["days"],
            "holiday": overlap_days(start, end, ranges) / iv["days"],
            "temp": _interval_temperature(iv, temps) if temps else None,
        })
    y = np.array([x["rate"] for x in rows])
    w = np.array([x["days"] for x in rows], dtype=float)
    hol = np.array([x["holiday"] for x in rows])
    use_holiday = (hol >= 0.5).sum() >= 3 and (hol < 0.5).sum() >= 3

    temp_rows = [x["temp"] for x in rows]
    use_temp = bool(temps) and horizon_temps and all(t is not None for t in temp_rows) and np.std(temp_rows) > 1.0
    t_mean = float(np.average(temp_rows, weights=w)) if use_temp else None
    out["weather"]["recordsMeanTemp"] = r(t_mean, 1)

    def fit(include_h, include_t):
        cols = [np.ones(len(y))]
        if include_h:
            cols.append(hol)
        if include_t:
            cols.append(np.array(temp_rows) - t_mean)
        return _wls(np.column_stack(cols), y, w)

    include_h, include_t = use_holiday, use_temp
    beta, p = fit(include_h, include_t)
    # Drop terms the data doesn't clearly support, then refit.
    idx = 1
    keep_h = include_h and p[idx] < EFFECT_P if include_h else False
    idx += 1 if include_h else 0
    keep_t = include_t and p[idx] < EFFECT_P if include_t else False
    if (keep_h, keep_t) != (include_h, include_t):
        include_h, include_t = keep_h, keep_t
        beta, p = fit(include_h, include_t)

    b0 = float(beta[0])
    b_h = float(beta[1]) if include_h else 0.0
    b_t = float(beta[1 + int(include_h)]) if include_t else 0.0
    mean_hol = float(np.average(hol, weights=w))
    base = b0 + b_h * mean_hol  # average fitted rate over the records
    if base <= 0:
        return out

    dT = (float(np.mean(horizon_temps)) - t_mean) if include_t else 0.0
    hol_part = b_h * (horizon_share - mean_hol) / base
    temp_part = b_t * dT / base
    m = min(max(1 + hol_part + temp_part, ADJUSTMENT_LIMITS[0]), ADJUSTMENT_LIMITS[1])
    out["multiplier"] = r(m, 3)

    if include_h:
        out["holiday"].update({"applied": True, "effect": r(b_h / base, 3), "contribution": r(hol_part, 3)})
        direction = "higher" if b_h > 0 else "lower"
        share = round(horizon_share * 100)
        out["explanation"].append(
            f"In your records, consumption during school holidays was {abs(b_h / base):.0%} {direction} than in term time. "
            f"{share}% of the planning horizon is in a school holiday, which changes the forecast by {hol_part:+.0%}."
        )
    elif use_holiday:
        out["explanation"].append("Your records show no clear difference between school holidays and term time, so holidays don't change the forecast.")
    else:
        out["explanation"].append("Not enough counts in and out of school holidays to compare them.")

    if include_t:
        per_deg = -b_t / base  # per degree colder
        out["weather"].update({"applied": True, "perDegree": r(per_deg, 4), "contribution": r(temp_part, 3)})
        colder = "colder" if dT < 0 else "warmer"
        out["explanation"].append(
            f"In your records, consumption was {abs(per_deg):.1%} {'higher' if per_deg > 0 else 'lower'} for each degree colder than average. "
            f"The next {horizon_days} days are expected to average {np.mean(horizon_temps):.1f}°C, {abs(dT):.1f}° {colder} than your records' average of {t_mean:.1f}°C, "
            f"which changes the forecast by {temp_part:+.0%}."
        )
    elif use_temp:
        out["explanation"].append("Your records show no clear link between temperature and consumption, so the weather forecast doesn't change the forecast.")
    elif not temps:
        out["explanation"].append("Past weather for your area wasn't available, so weather isn't used.")

    if m in ADJUSTMENT_LIMITS:
        out["explanation"].append(f"The adjustment was limited to ×{m:.2f} to avoid over-reacting to a small sample.")
    return out


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
        "percentPerMonth": r(pct_month, 2),
        "clear": bool(fit.pvalue < EFFECT_P),
    }


def supply(intervals, mu):
    rises = [iv for iv in intervals if iv["type"] == "rise"]
    total_days = sum(iv["days"] for iv in intervals if iv["days"] > 0)
    out = {
        "rises": len(rises),
        "risingShare": r(len(rises) / len(intervals), 3) if intervals else None,
        "medianDaysBetweenRises": None,
        "estimatedDeliverySize": None,
    }
    if mu and rises:
        out["estimatedDeliverySize"] = int(np.median([iv["change"] + mu * iv["days"] for iv in rises]))
    if len(rises) >= 3:
        ends = [d(iv["end"]) for iv in rises]
        out["medianDaysBetweenRises"] = float(np.median([(b - a).days for a, b in zip(ends, ends[1:])]))
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
        "expectedUnusedUnits": int(sum(x["expectedUnused"] or 0 for x in at_risk)) if mu else None,
        "atRiskBatches": len(at_risk),
    }


def analyse_product(pid, product, records, batches, holidays, weather, as_of, horizon_days):
    series = sorted(({**rec, "date": d(rec["date"])} for rec in records), key=lambda x: x["date"])
    intervals = classify_intervals(series)
    demand, used = demand_estimate(intervals)
    mu = demand.get("dailyMean")
    snapshot = series[-1]["date"] if series else None
    current = sum(b["quantity"] for b in batches) if batches else (series[-1]["quantity"] if series else 0)

    counts = {t: sum(1 for iv in intervals if iv["type"] == t) for t in ("fall", "rise", "censored", "excluded", "unchanged")}
    lengths = [iv["days"] for iv in intervals if iv["days"] > 0]
    typical = float(np.median(lengths)) if lengths else None

    flags = []

    def flag(level, code, message):
        flags.append({"level": level, "code": code, "message": message})

    if not demand["available"]:
        flag("warning", "no_estimate", "Too few falls in stock to estimate demand. Enter an estimate.")
    elif demand["intervalsUsed"] < FEW_INTERVALS:
        flag("warning", "few_intervals", f"Only {demand['intervalsUsed']} intervals could be used, so this estimate is uncertain.")
    if demand.get("fallback") == "censored_included":
        flag("warning", "censored_used", "Weeks that ended with no stock were included because few others were available, so real demand was probably higher.")
    if counts["censored"]:
        flag("warning", "stockouts", f"Stock ran out {counts['censored']} time(s). Demand while empty isn't recorded, so true demand may be higher.")
    if intervals and counts["rise"] / len(intervals) > 0.6:
        flag("warning", "mostly_rises", f"Stock rose in {counts['rise']} of {len(intervals)} intervals, so most consumption is hidden by deliveries.")
    if product.get("category") == "fresh_produce" and demand["available"]:
        flag("warning", "fresh_hidden", "Fresh produce often arrives in small, frequent deliveries that weekly counts don't show, so this estimate is likely to be too low.")
    if counts["excluded"]:
        flag("info", "excluded_movements", f"{counts['excluded']} interval(s) were left out because notes mention a transfer, correction or waste.")
    if snapshot and (as_of - snapshot).days > 7:
        flag("warning", "stale_count", f"The latest count is {(as_of - snapshot).days} days old. Current stock may have changed.")

    adj = adjustment(used, holidays, weather, mu, as_of, horizon_days) if demand["available"] else {"multiplier": 1.0, "explanation": ["No demand estimate."]}
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
        },
        "demand": demand,
        "trend": trend(used) if demand["available"] else {"available": False},
        "adjustment": adj,
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
    weather = payload.get("weather")
    by_product = {}
    for rec in payload.get("records", []):
        by_product.setdefault(rec["productId"], []).append(rec)
    batches = {}
    for b in payload.get("batches", []):
        batches.setdefault(b["productId"], []).append(b)

    products = {
        pid: analyse_product(pid, p, by_product.get(pid, []), batches.get(pid, []), holidays, weather, as_of, horizon)
        for pid, p in payload.get("products", {}).items()
    }
    return {
        "asOf": as_of.isoformat(),
        "horizonDays": horizon,
        "methods": METHODS,
        "weatherSource": (weather or {}).get("source"),
        "assumptions": [
            "Counts are snapshots: the change between two counts is deliveries minus consumption, waste and transfers.",
            "Interval totals are treated as sums of independent daily demands to convert them to daily figures.",
            "School holiday dates are a fixed calendar of typical England dates, not looked up for your area.",
        ],
        "products": products,
    }
