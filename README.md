# SA Battery Tracker

A public web page showing the estimated state of charge (SOC) of every grid-scale battery in South Australia (bidirectional units of 5 MW or more), with SA spot and AEMO forecast prices. It refreshes every 5 minutes and keeps 31 days of history.

## How it works

`scripts/update.py` (Python standard library only) pulls public AEMO NEMweb data:

| Feed | Used for |
|---|---|
| MMSDM `DUDETAILSUMMARY`, `DUDETAIL`, `STATION` | Battery list, MW, MWh, registered charge/discharge efficiency |
| `Next_Day_Dispatch` (`UNIT_SOLUTION`) | Each battery's telemetered stored energy and MW, published the morning after |
| `Public_Prices` (`DREGION`) | Settled SA 5-min price for completed days |
| `Dispatch_SCADA` | Live 5-min MW per battery |
| `DispatchIS_Reports` (`PRICE`) | Live SA 5-min price |
| `P5_Reports`, `PredispatchIS_Reports` | AEMO 5-min and 30-min price forecasts |

The estimate starts from the latest actual stored energy AEMO has published (4 am NEM time, end of the last trading day) and steps forward every 5 minutes with live SCADA:

- discharging: `E -= MW × 5/60 ÷ discharge efficiency`
- charging: `E += |MW| × 5/60 × charge efficiency`
- capped between 0 and usable capacity

Each battery's model is checked against the last 14 days of actuals. Usable capacity is the larger of registered MWh and the highest stored energy AEMO has reported, and a single round-trip efficiency factor replaces the registered values when it fits clearly better. The average error (as % of capacity) shows on the site as "Model fit".

## Hosting

`.github/workflows/update.yml` runs every 5 minutes on GitHub Actions:

1. restores state from the `data` branch,
2. runs the update,
3. force-pushes the `data` branch as a single commit (so repo history doesn't grow),
4. deploys `site/` plus the data to GitHub Pages.

Pages must be set to **Settings → Pages → Source: GitHub Actions**.

GitHub's scheduler is best-effort, so runs can land a few minutes late. GitHub also pauses scheduled workflows in a repo with no activity for 60 days; if that happens, re-enable it from the Actions tab.

## Run locally

```bash
DATA_DIR=data-out python3 scripts/update.py      # first run back-fills 31 days (~260 MB of AEMO downloads)
mkdir -p _site && cp -r site/* _site/ && cp -r data-out/data _site/data
python3 -m http.server -d _site 8000
```
