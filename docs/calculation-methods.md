# Calculation methods

Each method has an identifier, which is stored in the audit record of every finalised recommendation. A plan can then be traced to the exact method that produced it. All calculations run in `python/` with NumPy and SciPy; no language model produces or changes a number.

This document is completed as each module is implemented.

## Historical analysis (`analysis.py`)

To be documented: conversion of weekly counts to daily consumption estimates, separation of decreases (inferred consumption) from increases (inferred replenishment), and handling of gaps, transfers and corrections.

## Demand model (`demand_model.py`)

To be documented: method-of-moments estimates of μ̂, v̂ and α̂, the Poisson / negative binomial selection rule and fallbacks.

## Scenarios (`scenario_model.py`)

To be documented: the common configuration object and how each scenario modifies demand, reserve days and delivery assumptions.

## Policies (`policies.py`)

To be documented: Lean, Balanced and Resilient order-up-to targets, protection horizon, inventory position and capacity caps.

## Simulation (`simulation.py`)

To be documented: daily event order, common random numbers, delivery success and delay, FEFO and expiry.

## Metrics (`metrics.py`)

To be documented: unmet demand, shortage probability, service level, ending inventory, replenishment, utilisation, waste and CVaR₀.₉₅.
