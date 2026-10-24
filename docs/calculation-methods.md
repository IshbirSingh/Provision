# Calculation methods

Every finalised recommendation stores the identifiers below, so a plan can be traced to the exact method that produced it. All statistics, sampling, simulation and metrics run in `python/` with NumPy and SciPy. Nebius only interprets uploaded spreadsheets (Step 1) and writes text from finished results (Steps 4 and 5). It never produces or changes a number.

## Step 1: reading stock records

Column mapping and product grouping come from Nebius (`Qwen3-235B-A22B-Instruct-2507`), with header and keyword rules as the fallback. Every AI answer is checked against the file:

- every header must map to one known field
- every product name must be grouped exactly once
- a pack size must appear in the product's name

Dates, quantities and best-before dates are always parsed by code. Slash dates are read as day-first unless a value proves month-first. Approximate counts ("approx 40") are flagged for confirmation. Missing or unreadable values leave the row out, with the reason recorded; they are never filled in.

Notes that mention a transfer, correction or waste tag the row, so Step 2 doesn't treat that fall as demand.

## Step 2: historical analysis (`analysis.py`)

**`net_fall_intervals_v1`.** Each pair of consecutive counts is an interval of L days with change Δ:

| Interval | Treatment |
| --- | --- |
| Notes mention a transfer, correction or waste | Excluded: not demand |
| Δ > 0 | Replenishment. Consumption in that interval is unobserved |
| Δ < 0 and stock reached 0 | Censored: demand may have been higher. Excluded unless fewer than 3 other falls exist |
| Δ < 0 | Inferred consumption c = −Δ |
| Δ = 0 | Ambiguous: not used |

The result is labelled *inferred consumption*, not demand. Deliveries during an interval hide part of its consumption, so frequently delivered items, especially fresh produce, are flagged as likely underestimates.

**`mom_unequal_intervals_v1`.** Daily mean and variance, assuming independent daily demand, so an interval total has mean μL and variance vL:

- μ̂ = Σc ÷ ΣL
- v̂ = Σ (c − μ̂L)² ÷ L ÷ (n − 1)

With equal 7-day intervals this is mean(weekly) ÷ 7 and var(weekly) ÷ 7. The 95% range for weekly demand is 7(μ̂ ± 1.96 √(v̂ ÷ ΣL)).

**`mom_negbin_alpha_v1`.** Poisson if v̂ ≤ μ̂. Otherwise negative binomial with α̂ = (v̂ − μ̂) ÷ μ̂², so Var(D) = μ + αμ².

**`wls_holiday_temperature_v1`.** One model per product, fitted to its own records, estimates the effect of school holidays and temperature together, so neither is counted twice. Each interval's daily consumption rate is regressed, weighted by interval length, on:

- the share of the interval in a school holiday (fixed calendar of typical England dates)
- the average daily temperature over the interval, minus the records' average (Open-Meteo historical weather for the postcode)

A term is kept only if the data shows it clearly (two-sided t-test at 5%); otherwise it is dropped and the model refitted. The adjustment is the predicted rate for the planning horizon divided by the average fitted rate over the records:

a = 1 + b_h (f_H − f̄) ÷ base + b_t (T_H − T̄) ÷ base

Here f_H is the horizon's holiday share and f̄ the records' average share. T_H is the expected horizon temperature: the forecast for up to 16 days, then the same dates last year. The adjustment is limited to between 0.7 and 1.4, needs at least 10 usable intervals, and is applied automatically. The page explains it in words for each product.

**`ols_daily_rate_v1`.** A linear trend in the daily rate. It is mentioned only if it is clear, and is not applied automatically.

**`rise_intervals_v1`.** Counts rises in stock, their typical spacing, and estimates delivery size as rise + μ̂L.

**`fefo_expected_unused_v1`.** For each dated batch of current stock, the expected quantity left on its best-before date if stock is used oldest-date-first at the average daily rate. This is a simple expectation; Step 4 gives the full distribution.

Met Office warnings, IMD 2025, bank holidays and local links are shown for the manager's judgement and don't change any figures.

## Step 2: storage capacity (`capacity.py`, `consumption_weighted_space_allocation_v1`)

Nobody types in capacities.

1. Each storage area entered on the Organisation page is converted to litres, kilograms or item counts. The standard sizes used:
   - pallet: 1.2 × 1.0 m stacked to 1.5 m, 75% usable, about 1,350 L
   - shelf: 1 m long, 40 cm deep and 40 cm high, 80% usable, about 130 L
   - crate: about 45 L
2. Each product's unit volume, weight and storage type (ambient, chilled or frozen) are estimated by Nebius from its name and pack size. Answers are checked for range and density (0.4–8 L per kg), and rules are used for anything missing or implausible.
3. Within each storage type, product i gets this share of the space:
   share_i = μ_i v_i ÷ Σ μ_j v_j (daily demand × unit volume)
   Products that move faster or take more room get more space.
4. Capacity_i = share_i × space ÷ v_i, never less than the stock already held. A storage type with no space entered has no limit.

## Step 3: scenarios (`scenario_model.py`, `common_scenario_config_v1`)

One configuration object covers all four scenarios. The approved baseline is copied, never modified:

- μ_base = μ̂ × a (the holiday and temperature adjustment)
- μ = μ_base × (1 + demand increase)
- L′ = L + extra delay
- delivered = ⌊Q × (1 − quantity reduction)⌋
- reserve B = ⌈R × μ_base⌉, when the reserve applies

Adjustments that don't belong to the chosen preset apply only when the manager ticks "Also apply".

## Step 4: policies (`policies.py`, `order_up_to_horizon_quantile_v1`)

The protection horizon is h = lead time + order period. Lean and Balanced use the approved lead time L. Resilient uses L′, so it plans for the scenario's extra delay.

The target is T = ⌈F⁻¹(q)⌉ of demand over h. Demand over h is exact: a sum of h independent Poisson(μ) days is Poisson(hμ), and a sum of negative binomial days with shape 1 ÷ α is negative binomial with mean hμ and shape h ÷ α. Targets therefore never use the simulated futures being evaluated.

| Policy | q | Reserve |
| --- | --- | --- |
| Lean | 0.50 | Not applied |
| Balanced | 0.80 | T = max(T, B) |
| Resilient | Critical 0.95, Essential 0.90, Standard 0.80 | T = max(T, B) |

The order is Q = max(0, T − IP), where IP is stock on hand plus stock on order, capped so on hand plus on order stays within the product's capacity. Shortfalls caused by capacity are reported, not hidden.

**Fine-tuning.** After choosing a plan, the manager can set its protection level q between 50% and 99%. For Resilient this sets the critical level, and the essential and standard levels move by the same amount. Only that plan is re-simulated, with the same seed, so the demand checksum matches and it stays comparable with the other two.

**Why a shortage chance is high.** For any product with a shortage chance of 20% or more, the plan states the reasons the numbers support:

- current stock is below the demand expected before the first delivery
- no order can arrive within the horizon
- storage space limits the order
- scenario delays, smaller deliveries or higher demand
- Lean's lower protection level
- very changeable demand

## Step 4: simulation (`simulation.py`, `daily_fefo_monte_carlo_crn_v1`)

The defaults are 1,000 futures per policy with seed 42. Demand for every future, day and product is pre-generated once (`gamma_poisson_mixture_v1`: Λ ~ Gamma(1 ÷ α, αμ), D ~ Poisson(Λ)), The same draws are used for all three policies. These are the common random numbers.

Each day:

1. Scheduled deliveries arrive. Every delivery is assumed to arrive in full, as stock counts can't show reliability; the Delivery disruption scenario tests late or smaller deliveries.
2. Stock past its last usable day is removed and counted as waste.
3. On order days, the policy orders. The order arrives after the actual lead time L′, which every policy faces.
4. Demand is met from the earliest-dated stock first. The remainder is unmet.

The day-0 order is deterministic and is the "request now" quantity.

These checks run on every simulation and are stored with the results:

- demand samples are non-negative integers
- stock never goes negative
- stock balances: start + delivered − served − waste = end
- the same demand checksum is used for every policy

## Metrics (`metrics.py`)

**`monte_carlo_sample_means_v1`:**

- **Expected unmet demand:** the mean over futures of Σ unmet.
- **Shortage chance:** the share of futures with any unmet demand over the horizon.
- **Ending stock** and **average ordered:** means over futures.
- **Expected waste:** reported only where dates or a shelf life exist; otherwise "Insufficient data".
- **Shortage before the first delivery:** the share of futures that run short before day L′.

**`rockafellar_uryasev_cvar95_v1`.** CVaR₀.₉₅ = η + E[max(L − η, 0)] ÷ 0.05, with η the 95th percentile of total unmet demand.

There is no weighted overall score. The manager chooses after comparing.

## Steps 4–5: explanations

Nebius (`Qwen3-30B-A3B-Instruct-2507`) receives a facts object built from the stored results. It must return one sentence per item. A sentence is removed if it:

- contains a number or date that isn't in the facts
- gives a weekday deadline
- attaches a figure to a product it doesn't belong to
- says a product has no stock when it does
- uses the wrong priority or unit for a product
- calls stock "expiring" when no dated stock reaches its date
- merges figures from different policy comparisons
- claims "no difference" where the results differ

Empty sections, and any Nebius failure, fall back to deterministic templates.
