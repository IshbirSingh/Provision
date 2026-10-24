"""Demand estimation and sampling (spec section 4).

Poisson when variance <= mean, otherwise negative binomial with the
mean-dispersion parameterisation Var(D) = mu + alpha * mu^2, sampled as a
Gamma-Poisson mixture.
"""

import math

import numpy as np
from scipy import stats

ESTIMATE_METHOD = "mom_unequal_intervals_v1"
DISPERSION_METHOD = "mom_negbin_alpha_v1"
SAMPLING_METHOD = "gamma_poisson_mixture_v1"


def estimate_daily(consumption, lengths):
    """Method-of-moments daily mean and variance from interval totals.

    `consumption[k]` units were consumed over `lengths[k]` days. Assuming
    independent daily demand with mean mu and variance v, an interval total
    has mean mu*L and variance v*L, so

        mu_hat = sum(c) / sum(L)
        v_hat  = sum((c - mu_hat*L)^2 / L) / (n - 1)

    With equal 7-day intervals this is mean(weekly)/7 and var(weekly)/7
    (spec 4.1 applied to weekly totals). Returns (mu, v); v is None for n < 2.
    """
    c = np.asarray(consumption, dtype=float)
    L = np.asarray(lengths, dtype=float)
    n = len(c)
    if n == 0 or L.sum() <= 0:
        return None, None
    mu = float(c.sum() / L.sum())
    if n < 2:
        return mu, None
    v = float(np.sum((c - mu * L) ** 2 / L) / (n - 1))
    return mu, v


def choose_model(mu, v):
    """Poisson if v <= mu, else negative binomial with alpha = (v - mu) / mu^2."""
    if mu is None or mu <= 0 or v is None or v <= mu:
        return "poisson", 0.0
    return "negative_binomial", (v - mu) / mu ** 2


def daily_variance(mu, alpha):
    return mu + alpha * mu ** 2


def sample(rng, mu, alpha, size):
    """Draw non-negative integer demand with mean mu (array-broadcastable)."""
    mu = np.asarray(mu, dtype=float)
    if np.all(alpha <= 0):
        return rng.poisson(mu, size=size)
    shape = 1.0 / alpha
    lam = rng.gamma(shape, alpha * mu, size=size)
    return rng.poisson(lam)


def horizon_quantile(mu, alpha, h, q):
    """q-quantile of total demand over h days (independent days).

    Sum of h iid Poisson(mu) is Poisson(h*mu). Sum of h iid NB(mu, alpha)
    with common Gamma shape 1/alpha is NB with mean h*mu and shape h/alpha,
    so the quantile is exact in both cases.
    """
    if h <= 0 or mu <= 0:
        return 0
    m = h * mu
    if alpha <= 0:
        return int(stats.poisson.ppf(q, m))
    r = h / alpha  # NB shape (number of successes)
    p = r / (r + m)
    return int(stats.nbinom.ppf(q, r, p))


def normal_ci(mu, v, total_days, z=1.96):
    """95% interval for the daily mean: mu +/- z * sqrt(v / total_days)."""
    if mu is None or v is None or total_days <= 0:
        return None
    half = z * math.sqrt(v / total_days)
    return max(0.0, mu - half), mu + half
