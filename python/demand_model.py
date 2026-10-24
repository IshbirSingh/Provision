"""Demand estimation and sampling (spec section 4).

Poisson when variance <= mean, otherwise negative binomial with the
mean-dispersion parameterisation Var(D) = mu + alpha * mu^2, sampled as a
Gamma-Poisson mixture.
"""
