"""Performance metrics (spec section 7): unmet demand, shortage probability,
service level, ending inventory, replenishment, utilisation, waste and CVaR.
"""

import numpy as np

METHOD = "monte_carlo_sample_means_v1"
CVAR_METHOD = "rockafellar_uryasev_cvar95_v1"


def cvar(losses, level=0.95):
    """CVaR_a(L) = min_eta [eta + E[max(L - eta, 0)] / (1 - a)]  (spec 7.8).

    The minimum is attained at eta = VaR_a, the a-quantile of L.
    """
    losses = np.asarray(losses, dtype=float)
    eta = float(np.quantile(losses, level, method="inverted_cdf"))
    return eta + float(np.mean(np.maximum(losses - eta, 0.0))) / (1.0 - level)


def service_level(unmet, demand):
    """SL = 1 - sum(U) / sum(D); undefined when total demand is zero (7.3)."""
    total = float(np.sum(demand))
    return None if total == 0 else 1.0 - float(np.sum(unmet)) / total


def r(x, n=3):
    if x is None:
        return None
    x = float(x)
    return None if np.isnan(x) or np.isinf(x) else round(x, n)


def histogram(series_by_policy, bins=30):
    """Shared bin edges so the policies' distributions can be compared."""
    allv = np.concatenate([np.asarray(v, dtype=float) for v in series_by_policy.values()])
    hi = float(allv.max()) if allv.size else 0.0
    edges = np.linspace(0.0, hi if hi > 0 else 1.0, bins + 1)
    return {
        "edges": [r(e, 1) for e in edges],
        "counts": {k: np.histogram(v, bins=edges)[0].tolist() for k, v in series_by_policy.items()},
    }
