#!/usr/bin/env python3
"""Refresh the SA BESS tracker data.

Public AEMO NEMweb feeds used (all free, no login):
  MMSDM DUDETAILSUMMARY / DUDETAIL / STATION   which SA batteries exist, MW, MWh, efficiencies
  Next_Day_Dispatch  (DISPATCH UNIT_SOLUTION)  each battery's telemetered stored energy + MW, published the day after
  Public_Prices      (DREGION)                 settled 5-min SA spot price for completed days
  Dispatch_SCADA     (DISPATCH UNIT_SCADA)     live 5-min MW per battery
  DispatchIS_Reports (DISPATCH PRICE)          live 5-min SA spot price
  P5_Reports         (P5MIN REGIONSOLUTION)    AEMO 5-min price forecast, next hour
  PredispatchIS      (PREDISPATCH REGION_PRICES) AEMO 30-min price forecast, to end of next trading day

Model: start from the latest stored energy AEMO has published for each battery, then step forward
5 minutes at a time with live SCADA MW and the battery's registered charge/discharge efficiency.

Time convention: every 5-min value is stamped at the START of its dispatch interval
(AEMO's SETTLEMENTDATE minus 5 minutes), as epoch milliseconds. SCADA, INITIALMW and
INITIAL_ENERGY_STORAGE are all snapshots taken at that moment.

Standard library only.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import statistics
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data-out")).resolve()
CACHE = DATA / "cache"
PUB = DATA / "data"
DAYS = PUB / "days"

NEMWEB = "https://nemweb.com.au"
D_SCADA = "/Reports/Current/Dispatch_SCADA/"
D_DISPIS = "/Reports/Current/DispatchIS_Reports/"
D_NDD = "/Reports/Current/Next_Day_Dispatch/"
D_PRICES = "/Reports/Current/Public_Prices/"
D_P5 = "/Reports/Current/P5_Reports/"
D_PD = "/Reports/Current/PredispatchIS_Reports/"
MMSDM = "/Data_Archive/Wholesale_Electricity/MMSDM/{y}/MMSDM_{y}_{m:02d}/MMSDM_Historical_Data_SQLLoader/DATA/"

NEM_TZ = timezone(timedelta(hours=10))  # NEM market time, no daylight saving
REGION = "SA1"
STEP_MS = 300_000
H = 5 / 60
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "31"))
MIN_MW = 5          # "utility scale": AEMO's 5 MW threshold for scheduled units
CALIBRATE_DAYS = 14
REGISTRY_MAX_AGE_DAYS = 7
UA = {"User-Agent": "sa-bess-tracker/1.0"}
TS_FMT = "%Y/%m/%d %H:%M:%S"


# ------------------------------------------------------------------ helpers
def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(path: str, tries: int = 4, timeout: int = 90) -> bytes:
    url = path if path.startswith("http") else NEMWEB + path
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1 or "404" in str(e):
                raise
            log(f"  retry {i + 1}: {url}: {e}")
            time.sleep(3 * (i + 1))
    raise RuntimeError


def listing(path: str, pattern: str) -> list[str]:
    return sorted(set(re.findall(pattern, fetch(path).decode("utf-8", "replace"))))


def mms(zip_bytes: bytes, wanted: set[str]):
    """Yield (GROUP.TABLE, row dict) from AEMO MMS CSVs in a zip (nested zips handled)."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for name in z.namelist():
            raw = z.read(name)
            if name.lower().endswith(".zip"):
                yield from mms(raw, wanted)
                continue
            header = key = None
            for row in csv.reader(io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8", errors="replace")):
                if not row:
                    continue
                if row[0] == "I":
                    key = f"{row[1]}.{row[2]}"
                    header = row[4:] if key in wanted else None
                elif row[0] == "D" and header is not None and f"{row[1]}.{row[2]}" == key:
                    yield key, dict(zip(header, row[4:]))


def to_ms(s: str, shift_min: int = 0) -> int:
    d = datetime.strptime(s, TS_FMT).replace(tzinfo=NEM_TZ) + timedelta(minutes=shift_min)
    return int(d.timestamp() * 1000)


def ms_to_nem(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, NEM_TZ)


def num(s, default=None):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def r1(x):
    return None if x is None else round(x, 1)


def load(p: Path, default):
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return default


def save(p: Path, obj, pretty=False):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=1) if pretty else json.dumps(obj, separators=(",", ":")))
    tmp.replace(p)


def parallel(fn, items, workers=12):
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(fn, items))


# ------------------------------------------------------------------ registry
def registry(now: datetime) -> dict:
    path = CACHE / "units.json"
    cur = load(path, None)
    if cur and (now - datetime.fromisoformat(cur["refreshed"])).days < REGISTRY_MAX_AGE_DAYS:
        return cur
    nowstr = now.strftime(TS_FMT)
    for back in range(4):
        y, m = now.year, now.month - back
        while m <= 0:
            y, m = y - 1, m + 12
        base = MMSDM.format(y=y, m=m)
        try:
            files = listing(base, r'HREF="[^"]*/(PUBLIC_[^"/]*?\.zip)"')
        except Exception as e:  # noqa: BLE001
            log(f"no MMSDM {y}-{m:02d} ({e})")
            continue

        def pick(t):
            return next((base + f for f in files if re.search(rf"(%23|_DVD_){t}(%23|_\d)", f, re.I)), None)

        u_sum, u_det, u_sta = pick("DUDETAILSUMMARY"), pick("DUDETAIL"), pick("STATION")
        if not (u_sum and u_det):
            continue
        log(f"registry: MMSDM {y}-{m:02d}")
        summ = {r["DUID"]: r for _, r in mms(fetch(u_sum), {"PARTICIPANT_REGISTRATION.DUDETAILSUMMARY"})
                if r["REGIONID"] == REGION and r["DISPATCHTYPE"] == "BIDIRECTIONAL"
                and r["START_DATE"] <= nowstr < r["END_DATE"]}
        det = {}
        for _, r in mms(fetch(u_det), {"PARTICIPANT_REGISTRATION.DUDETAIL"}):
            if r["DUID"] in summ and r["EFFECTIVEDATE"] <= nowstr:
                k = (r["EFFECTIVEDATE"], int(r["VERSIONNO"] or 0))
                if r["DUID"] not in det or k > det[r["DUID"]][0]:
                    det[r["DUID"]] = (k, r)
        names = {}
        if u_sta:
            names = {r["STATIONID"]: (r.get("STATIONNAME") or "").strip()
                     for _, r in mms(fetch(u_sta), {"PARTICIPANT_REGISTRATION.STATION"})}
        units = {}
        for duid, s in summ.items():
            if duid not in det:
                continue
            d = det[duid][1]
            cap = num(d.get("MAXSTORAGECAPACITY"))
            mw = num(d.get("MAXCAPACITY")) or num(d.get("REGISTEREDCAPACITY")) or 0
            if not cap or mw < MIN_MW:
                continue
            units[duid] = {
                "duid": duid,
                "station": s["STATIONID"],
                "name": tidy_name(names.get(s["STATIONID"]) or s["STATIONID"]),
                "participant": s.get("PARTICIPANTID", ""),
                "mw": mw,
                "mwh": cap,
                "reg_mwh": cap,
                "eff_in": num(d.get("STORAGEIMPORTEFFICIENCYFACTOR"), 0.92) or 0.92,
                "eff_out": num(d.get("STORAGEEXPORTEFFICIENCYFACTOR"), 0.92) or 0.92,
            }
        reg = {"refreshed": now.isoformat(), "source": f"AEMO MMSDM {y}-{m:02d}", "units": units}
        save(path, reg, pretty=True)
        return reg
    if cur:
        log("registry refresh failed; using cached copy")
        return cur
    raise RuntimeError("could not build battery registry")


def tidy_name(n: str) -> str:
    n = re.sub(r"\s+", " ", n).strip()
    for pat in (r"\s*Battery Energy Storage System\s*", r"\s*Battery Energy Storage\s*",
                r"\s*Energy Storage System\s*", r"\s*BESS\s*$"):
        n = re.sub(pat, " ", n, flags=re.I).strip()
    return n or n


# ------------------------------------------------------------------ model
def step(e: float, mw: float, u: dict) -> float:
    """Stored energy after 5 minutes at `mw` (positive = discharging to the grid)."""
    e -= mw * H / u["eff_out"] if mw >= 0 else mw * H * u["eff_in"]
    return min(max(e, 0.0), u["mwh"])


def backtest(u: dict, mw: list, act: list):
    """Run the model across a completed day from its first actual; error as % of capacity."""
    start = next((i for i, v in enumerate(act) if v is not None), None)
    if start is None:
        return None
    e, errs = act[start], []
    for i in range(start, len(act) - 1):
        e = step(e, mw[i] or 0.0, u)
        if act[i + 1] is not None:
            errs.append(abs(e - act[i + 1]))
    if not errs:
        return None
    return {"mae_pct": round(100 * statistics.mean(errs) / u["mwh"], 2),
            "end_pct": round(100 * errs[-1] / u["mwh"], 2)}


def calibrate(units: dict, day_files: list) -> None:
    """Tune each battery's model from recent completed days.

    * usable capacity = max(registered MWh, highest stored energy AEMO has reported)
    * efficiency: keep AEMO's registered factors unless a single round-trip scale factor
      fits the last CALIBRATE_DAYS days clearly better (>10% lower error)
    """
    days = [load(p, {}) for p in day_files[-CALIBRATE_DAYS:]]
    for duid, u in units.items():
        series = [(d["units"][duid]["mw"], d["units"][duid]["e"]) for d in days if duid in d.get("units", {})]
        if not series:
            u["eff_source"] = "registered"
            continue
        peak = max((v for _, e in series for v in e if v is not None), default=0)
        u["mwh"] = round(max(u["reg_mwh"], peak), 1)

        def score(ei, eo):
            v = {**u, "eff_in": ei, "eff_out": eo}
            res = [backtest(v, mw, e) for mw, e in series]
            res = [r["mae_pct"] for r in res if r]
            return statistics.mean(res) if res else 1e9

        base = score(u["eff_in"], u["eff_out"])
        best = (base, u["eff_in"], u["eff_out"])
        for k in [x / 100 for x in range(80, 101)]:
            sc = score(k, k)
            if sc < best[0]:
                best = (sc, k, k)
        if best[0] < 0.9 * base:
            u["eff_in"], u["eff_out"], u["eff_source"] = best[1], best[2], "fitted"
        else:
            u["eff_source"] = "registered"
        u["fit_err_pct"] = round(min(base, best[0]), 1)


# ------------------------------------------------------------------ completed days
def trading_day_start(date: str) -> int:
    """First 5-min point of trading day `date` (YYYYMMDD) = 04:00 NEM (interval ending 04:05)."""
    d = datetime.strptime(date, "%Y%m%d").replace(hour=4, tzinfo=NEM_TZ)
    return int(d.timestamp() * 1000)


def build_days(units: dict) -> None:
    ndd = listing(D_NDD, r"(PUBLIC_NEXT_DAY_DISPATCH_(\d{8})_\d+\.zip)")
    prices = {d: f for f, d in listing(D_PRICES, r"(PUBLIC_PRICES_(\d{8})0000_\d+\.zip)")}
    ndd = ndd[-HISTORY_DAYS:]
    keep = {d for _, d in ndd}
    todo = []
    for f, d in ndd:
        p = DAYS / f"{d[:4]}-{d[4:6]}-{d[6:]}.json"
        cur = load(p, None)
        if cur is None or (not cur.get("price_final") and d in prices):
            todo.append((f, d, p))
    log(f"days: {len(todo)} to build")

    def one(job):
        f, d, p = job
        t0 = trading_day_start(d)
        n = 288
        mw = {u: [None] * n for u in units}
        act = {u: [None] * n for u in units}
        best = {}
        for _, r in mms(fetch(D_NDD + f, timeout=240), {"DISPATCH.UNIT_SOLUTION"}):
            u = r["DUID"]
            if u not in units:
                continue
            i = (to_ms(r["SETTLEMENTDATE"], -5) - t0) // STEP_MS
            if not 0 <= i < n:
                continue
            iv = int(r.get("INTERVENTION") or 0)  # physical outcome = intervention run when one exists
            if (u, i) in best and best[(u, i)] > iv:
                continue
            best[(u, i)] = iv
            mw[u][i] = num(r.get("INITIALMW"))
            act[u][i] = num(r.get("INITIAL_ENERGY_STORAGE"))
        price = [None] * n
        final = False
        if d in prices:
            pb = {}
            for _, r in mms(fetch(D_PRICES + prices[d]), {"DREGION."}):
                if r["REGIONID"] != REGION:
                    continue
                i = (to_ms(r["SETTLEMENTDATE"], -5) - t0) // STEP_MS
                iv = int(r.get("INTERVENTION") or 0)
                if 0 <= i < n and (i not in pb or iv <= pb[i]):  # pricing run = INTERVENTION 0
                    pb[i] = iv
                    price[i] = num(r["RRP"])
            final = True
        else:  # fall back to live dispatch prices we cached
            cache = load(CACHE / "price.json", {"p": {}})["p"]
            for i in range(n):
                price[i] = cache.get(str(t0 + i * STEP_MS))
        acc = {u: backtest(units[u], mw[u], act[u]) for u in units}
        day = {
            "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
            "start": t0,
            "step": STEP_MS,
            "price_final": final,
            "price": [r1(x) for x in price],
            "units": {u: {"mw": [r1(x) for x in mw[u]], "e": [r1(x) for x in act[u]]}
                      for u in units if any(v is not None for v in act[u]) or any(mw[u])},
            "acc": {u: a for u, a in acc.items() if a},
        }
        save(p, day)
        return d

    for d in parallel(one, todo, workers=4):
        log(f"  built {d}")
    for p in DAYS.glob("*.json"):
        if p.stem.replace("-", "") not in keep:
            p.unlink()


# ------------------------------------------------------------------ live feeds
def live_feed(dir_: str, pattern: str, since_ms: int, cache_name: str, parse) -> dict:
    """Fetch each new 5-min file newer than since_ms; parse(bytes) -> {ms: value-or-dict}."""
    path = CACHE / cache_name
    cache = load(path, {"files": [], "p": {}})
    have = set(cache["files"])
    files = listing(dir_, pattern)
    todo = []
    for f, stamp in files:
        if f in have:
            continue
        if to_ms(f"{stamp[:4]}/{stamp[4:6]}/{stamp[6:8]} {stamp[8:10]}:{stamp[10:12]}:00", -5) <= since_ms - STEP_MS:
            continue
        todo.append(f)
    log(f"{cache_name}: {len(todo)} new files")

    def get(f):
        try:
            return f, parse(fetch(dir_ + f))
        except Exception as e:  # noqa: BLE001
            log(f"  failed {f}: {e}")
            return None, {}

    for f, vals in parallel(get, todo):
        if f:
            have.add(f)
            cache["p"].update({str(k): v for k, v in vals.items()})
    floor = since_ms - 6 * 3600_000
    cache["p"] = {k: v for k, v in cache["p"].items() if int(k) >= floor}
    listed = {f for f, _ in files}
    cache["files"] = sorted(f for f in have if f in listed)
    save(path, cache)
    return {int(k): v for k, v in cache["p"].items()}


def parse_scada(units):
    def p(b):
        out = {}
        for _, r in mms(b, {"DISPATCH.UNIT_SCADA"}):
            if r["DUID"] in units:
                out.setdefault(to_ms(r["SETTLEMENTDATE"], -5), {})[r["DUID"]] = num(r["SCADAVALUE"], 0.0)
        return out
    return p


def parse_dispatch_price(b):
    out = {}
    for _, r in mms(b, {"DISPATCH.PRICE"}):
        if r["REGIONID"] == REGION and r.get("INTERVENTION", "0") == "0":
            out[to_ms(r["SETTLEMENTDATE"], -5)] = num(r["RRP"])
    return out


def forecasts() -> dict:
    out = {"p5": [], "pd": [], "p5_run": None, "pd_run": None}
    try:
        f = listing(D_P5, r"(PUBLIC_P5MIN_\d{12}_\d+\.zip)")[-1]
        rows = {}
        for _, r in mms(fetch(D_P5 + f), {"P5MIN.REGIONSOLUTION"}):
            if r["REGIONID"] == REGION and r["INTERVENTION"] == "0":
                rows[to_ms(r["INTERVAL_DATETIME"], -5)] = num(r["RRP"])
                out["p5_run"] = to_ms(r["RUN_DATETIME"])
        out["p5"] = [[k, r1(v)] for k, v in sorted(rows.items())]
    except Exception as e:  # noqa: BLE001
        log(f"P5MIN failed: {e}")
    try:
        f = listing(D_PD, r"(PUBLIC_PREDISPATCHIS_\d{12}_\d+\.zip)")[-1]
        rows = {}
        for _, r in mms(fetch(D_PD + f), {"PREDISPATCH.REGION_PRICES"}):
            if r["REGIONID"] == REGION and r["INTERVENTION"] == "0":
                rows[to_ms(r["DATETIME"], -30)] = num(r["RRP"])
                out["pd_run"] = to_ms(r["LASTCHANGED"]) if r.get("LASTCHANGED") else None
        out["pd"] = [[k, r1(v)] for k, v in sorted(rows.items())]
    except Exception as e:  # noqa: BLE001
        log(f"Predispatch failed: {e}")
    return out


# ------------------------------------------------------------------ main
def main():
    now = datetime.now(NEM_TZ).replace(microsecond=0)
    reg = registry(now)
    units = reg["units"]
    build_days(units)

    day_files = sorted(DAYS.glob("*.json"))
    if not day_files:
        raise RuntimeError("no completed days available")
    calibrate(units, day_files)
    last_day = load(day_files[-1], {})
    n = len(last_day["price"])
    anchor_ms = last_day["start"] + (n - 1) * STEP_MS
    anchor_e = {}
    for u, s in last_day["units"].items():
        # latest actual in the last day (normally the final point)
        for i in range(n - 1, -1, -1):
            if s["e"][i] is not None:
                anchor_e[u] = (last_day["start"] + i * STEP_MS, s["e"][i], s["mw"][i])
                break

    scada = live_feed(D_SCADA, r"(PUBLIC_DISPATCHSCADA_(\d{12})_\d+\.zip)", anchor_ms, "scada.json", parse_scada(units))
    price = live_feed(D_DISPIS, r"(PUBLIC_DISPATCHIS_(\d{12})_\d+\.zip)", anchor_ms, "price.json", parse_dispatch_price)

    last = max([t for t in scada if t > anchor_ms] or [anchor_ms])
    grid = list(range(anchor_ms, last + 1, STEP_MS))
    live_units, summary = {}, []
    fleet = {"mw": 0.0, "mwh": 0.0, "cap_mwh": 0.0, "cap_mw": 0.0, "charging_mw": 0.0, "discharging_mw": 0.0}


    for duid, u in units.items():
        mw_series, e_series = [], []
        a = anchor_e.get(duid)
        e = None
        if a:
            t_a, e, mw_a = a
        last_mw = 0.0
        for t in grid:
            if t == anchor_ms:
                mw = (a[2] if a else None)
                mw_series.append(mw)
                e_series.append(r1(e))
                last_mw = mw or 0.0
                continue
            row = scada.get(t, {})
            mw = row.get(duid)
            # energy moved during the previous interval uses the MW at its start
            if e is not None:
                e = step(e, last_mw, u)
            mw_series.append(r1(mw))
            e_series.append(r1(e))
            if mw is not None:
                last_mw = mw
        live_units[duid] = {"mw": mw_series, "e": e_series}
        mw_now = next((v for v in reversed(mw_series) if v is not None), None)
        soc = e / u["mwh"] if e is not None else None
        # below ~3% of rated power (or 1 MW) counts as idle: SCADA noise, auxiliaries, FCAS trims
        thresh = max(1.0, 0.03 * (u["mw"] or 0))
        mode = "discharging" if (mw_now or 0) >= thresh else "charging" if (mw_now or 0) <= -thresh else "idle"
        hrs = None
        if e is not None and mode == "discharging":
            hrs = e * u["eff_out"] / mw_now
        elif e is not None and mode == "charging":
            hrs = (u["mwh"] - e) / (-mw_now * u["eff_in"])
        summary.append({
            **u,
            "now_mw": mw_now,
            "now_mwh": r1(e),
            "soc": None if soc is None else round(soc, 4),
            "mode": mode,
            "hours_to_limit": None if hrs is None else round(hrs, 1),
            "anchor": a[0] if a else None,
            "anchor_mwh": a[1] if a else None,
            "typical_err_pct": u.get("fit_err_pct"),
        })
        if e is not None:
            fleet["mwh"] += e
            fleet["cap_mwh"] += u["mwh"]
        fleet["cap_mw"] += u["mw"] or 0
        fleet["mw"] += mw_now or 0
        if (mw_now or 0) > 0:
            fleet["discharging_mw"] += mw_now
        else:
            fleet["charging_mw"] += mw_now or 0
    # ---- estimated energy revenue over the last 24 hours: sum(MW x price x 5/60)
    t_end = grid[-1]
    t_from = t_end - 24 * 3600_000
    mw_at, price_at = {}, {}
    for p in day_files[-2:]:
        d = load(p, {})
        for i, pr in enumerate(d.get("price", [])):
            t = d["start"] + i * STEP_MS
            if t > t_from:
                price_at[t] = pr
                for duid, ser in d["units"].items():
                    mw_at.setdefault(duid, {})[t] = ser["mw"][i]
    for i, t in enumerate(grid):
        if t > t_from:
            if price.get(t) is not None:
                price_at[t] = price.get(t)
            for duid, ser in live_units.items():
                if ser["mw"][i] is not None:
                    mw_at.setdefault(duid, {})[t] = ser["mw"][i]
    fleet["rev_24h"] = 0.0
    for srow in summary:
        m = mw_at.get(srow["duid"], {})
        tot, n = 0.0, 0
        for t, pr in price_at.items():
            v = m.get(t)
            if v is not None and pr is not None:
                tot += v * pr * H
                n += 1
        srow["rev_24h"] = round(tot) if n >= 200 else None  # need most of the day to be meaningful
        if srow["rev_24h"] is not None:
            fleet["rev_24h"] += tot
    fleet["rev_24h"] = round(fleet["rev_24h"])
    summary.sort(key=lambda s: -s["mwh"])
    fleet = {k: round(v, 1) for k, v in fleet.items()}
    fleet["soc"] = round(fleet["mwh"] / fleet["cap_mwh"], 4) if fleet["cap_mwh"] else None
    fleet["count"] = len(summary)
    fleet["tracked"] = sum(1 for s in summary if s["now_mwh"] is not None)

    live = {
        "generated": int(now.timestamp() * 1000),
        "anchor": anchor_ms,
        "start": grid[0],
        "step": STEP_MS,
        "latest": grid[-1],
        "price": [r1(price.get(t)) for t in grid],
        "units": live_units,
        "forecast": forecasts(),
        "fleet": fleet,
        "summary": summary,
        "registry": {"source": reg["source"], "refreshed": reg["refreshed"]},
    }
    save(PUB / "live.json", live)
    save(PUB / "index.json", {
        "generated": live["generated"],
        "days": [p.stem for p in day_files],
        "units": sorted(units.values(), key=lambda x: -x["mwh"]),
    }, pretty=True)
    log(f"done: {fleet['tracked']}/{fleet['count']} batteries, fleet SOC {fleet['soc']}, "
        f"{fleet['mw']} MW, latest {ms_to_nem(grid[-1]):%Y-%m-%d %H:%M} NEM")


if __name__ == "__main__":
    main()
