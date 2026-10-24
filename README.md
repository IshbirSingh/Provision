# SupplyShield

Decision support for UK food banks. Upload historical stock counts, approve the inferred planning parameters, test a scenario, compare three replenishment policies (Lean, Balanced, Resilient) under 1,000 seeded Monte Carlo runs, then finalise an explainable plan.

SupplyShield supports staff judgement; it doesn't replace it.

## Requirements

- Node.js 20+
- Python 3.10+ with NumPy, pandas and SciPy

## Setup

```sh
npm install
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt   # Windows
# .venv/bin/python -m pip install -r requirements.txt     # macOS / Linux
cp .env.example .env    # then fill in the keys
```

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs session cookies |
| `NEBIUS_API_KEY` | Data interpretation and explanations. Without it, deterministic fallbacks are used |
| `NEBIUS_BASE_URL`, `NEBIUS_MODEL_ADVANCED`, `NEBIUS_MODEL_EFFICIENT` | Nebius endpoint and models |
| `TAVILY_API_KEY` | External context search (optional) |
| `PYTHON_BIN` | Override the Python interpreter (defaults to `.venv`) |

## Run

```sh
npm run dev      # restarts on file changes
npm start
```

Open http://localhost:3000. The first account creates the organisation; later accounts join the same workspace.

## Test

```sh
npm test         # storage and HTTP integration tests
npm run test:py  # Python engine tests
```

## How it fits together

- **Express** (`app.js`, `routes/`) serves the EJS pages and owns `data/data.json`. Every write goes through `services/storageService.js`, which validates the document, writes atomically and queues writes.
- **Python** (`python/`) does all statistics, sampling, simulation and metrics. It receives JSON on stdin and returns JSON on stdout through `services/pythonBridge.js`, and never touches the data file.
- **Nebius** (`services/nebiusService.js`) interprets uploaded spreadsheets and writes explanations from finished calculations. It never produces numbers.
- **Tavily** (`services/tavilyService.js`) gathers external context. It is optional.

## Sample data

`data/sample/` holds a fictional 12-month weekly stock history (CSV and XLSX) and `seed.json`, the same data in cleaned form. **Reset to sample data** on the overview page loads the seed. To regenerate both:

```sh
.venv\Scripts\python scripts\generate_sample_data.py
```

Calculation methods are documented in [docs/calculation-methods.md](docs/calculation-methods.md).
