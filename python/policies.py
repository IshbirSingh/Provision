"""Lean, Balanced and Resilient replenishment policies (spec section 5).

Order-up-to targets from quantiles of demand over the protection horizon,
using inventory position (on hand + on order) and optional capacity caps.
"""
