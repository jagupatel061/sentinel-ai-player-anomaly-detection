"""
Sentinel AI - Backend API + Database
====================================
A Flask server that:
  * trains the DBSCAN model on the reference population (data/processed/player_features.csv)
  * exposes a REST API the website calls to scan a NEW player
  * saves every scan to a SQLite database (backend/sentinel.db)
  * serves the website itself (frontend/) so everything runs from one command

Run from the repo root:
    python backend/app.py
Then open http://localhost:5000

API
---
GET  /api/health            -> server status
GET  /api/model             -> model parameters, feature ranges, demo presets
POST /api/scan              -> JSON {gamertag, match_id, features{...}}   -> verdict (saved)
POST /api/scan/upload       -> form-data gamertag, match_id, file(.csv)   -> verdict (saved)
POST /api/challenge         -> "Beat Sentinel": simulate 20 matches with a user-designed cheat (saved)
GET  /api/leaderboard       -> Hall of Fame (undetected cheats) and Wall of Shame (caught)
GET  /api/scans?limit=25    -> scan history from the database
GET  /api/stats             -> totals per verdict
DELETE /api/scans           -> clear scan history
"""

import io
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, send_from_directory
from sklearn.cluster import DBSCAN
from sklearn.decomposition import PCA
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BACKEND_DIR)
sys.path.insert(0, BACKEND_DIR)
from pipeline import FEATURES, MIN_SAMPLES, MICRO_FRAC, choose_eps, extract_features  # noqa: E402

FEATURES_CSV = os.path.join(ROOT, "data", "processed", "player_features.csv")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
DB_PATH = os.environ.get("SENTINEL_DB", os.path.join(BACKEND_DIR, "sentinel.db"))

LABELS = {
    "mean_speed": ("Mean speed", "units/tick"),
    "max_speed": ("Max speed", "units/tick"),
    "speed_std": ("Speed variance", "σ"),
    "snap_angle": ("Snap angle", "°"),
    "aim_jitter": ("Aim jitter", "°"),
    "reaction_mean": ("Reaction time", "ms"),
    "reaction_std": ("Reaction consistency", "ms"),
    "hit_rate": ("Hit rate", "ratio"),
    "headshot_rate": ("Headshot rate", "ratio"),
    "path_straightness": ("Path straightness", "ratio"),
}
EXPLAIN = {
    "mean_speed": ("moves much faster than normal players", "moves unusually slowly"),
    "max_speed": ("reaches speeds above the game's movement cap", "never reaches normal top speed"),
    "speed_std": ("has erratic, jumpy movement speed", "moves at an unnaturally constant speed"),
    "snap_angle": ("snaps the crosshair onto targets unnaturally hard", "barely turns toward targets"),
    "aim_jitter": ("has very shaky aim", "has almost no natural hand shake - robot-steady aim"),
    "reaction_mean": ("reacts very slowly", "reacts faster than humanly typical"),
    "reaction_std": ("has very inconsistent reaction times", "reacts with machine-like consistency"),
    "hit_rate": ("lands far more shots than normal players", "misses far more than normal"),
    "headshot_rate": ("gets an unusually high share of headshots", "almost never hits headshots"),
    "path_straightness": ("moves in unusually straight lines", "wanders unusually"),
}


# =====================================================================  model
class SentinelModel:
    """DBSCAN fitted on the reference population. New players are scored by their
    distance to the nearest core point of a NORMAL cluster, divided by eps."""

    def __init__(self, csv_path):
        ref = pd.read_csv(csv_path)
        self.ref = ref
        self.scaler = StandardScaler().fit(ref[FEATURES])
        X = self.scaler.transform(ref[FEATURES])
        self.eps, _, _ = choose_eps(X)
        model = DBSCAN(eps=self.eps, min_samples=MIN_SAMPLES).fit(X)
        labels = model.labels_
        sizes = pd.Series(labels[labels != -1]).value_counts()
        normal = set(sizes[sizes >= MICRO_FRAC * len(labels)].index)
        core = [i for i in model.core_sample_indices_ if labels[i] in normal]
        self.nn = NearestNeighbors(n_neighbors=1).fit(X[core])
        self.pca = PCA(n_components=2).fit(X)
        self.n_core = len(core)
        self.medians = ref[FEATURES].median()
        self.human_medians = ref[ref["true_label"] == "human"][FEATURES].median() if "true_label" in ref else self.medians

        # slider ranges: a little wider than the reference data
        self.ranges = {}
        for f in FEATURES:
            lo, hi = float(ref[f].min()), float(ref[f].max())
            pad = (hi - lo) * 0.15
            self.ranges[f] = [max(0.0, lo - pad), hi + pad]
        for f in ("hit_rate", "headshot_rate", "path_straightness"):
            self.ranges[f] = [0.0, 1.0]

        # one-click demo presets (averages of each group in the reference data)
        self.presets = {}
        humans = ref[ref["true_label"] == "human"]
        self.presets["Casual player"] = humans[FEATURES].median().to_dict()
        pro = humans.sort_values("hit_rate", ascending=False).head(15)
        pro = pro[pro["is_anomaly"] == 0] if "is_anomaly" in pro else pro
        self.presets["Pro player"] = pro[FEATURES].median().to_dict()
        for t, name in (("aimbot", "Aimbot"), ("speedhack", "Speedhack"), ("triggerbot", "Triggerbot")):
            grp = ref[ref["true_label"] == t]
            if len(grp):
                self.presets[name] = grp[FEATURES].median().to_dict()

    def score(self, feats):
        row = pd.DataFrame([{f: float(feats[f]) for f in FEATURES}])
        z = self.scaler.transform(row[FEATURES])
        dist = float(self.nn.kneighbors(z)[0][0, 0])
        s = dist / self.eps
        tier = "clean" if s <= 1.0 else "review" if s < 1.8 else "high" if s < 2.5 else "critical"
        zs = dict(zip(FEATURES, z[0]))
        top = sorted(FEATURES, key=lambda f: -abs(zs[f]))[:3]
        reasons = []
        for f in top:
            zf = float(zs[f])
            reasons.append({
                "feature": f, "label": LABELS[f][0], "z": round(zf, 2),
                "value": round(float(feats[f]), 4), "normal": round(float(self.medians[f]), 4),
                "text": EXPLAIN[f][0 if zf >= 0 else 1],
            })
        px, py = self.pca.transform(z)[0]
        return {
            "score": round(s, 4), "is_anomaly": s > 1.0, "tier": tier,
            "reasons": reasons, "pca": [round(float(px), 4), round(float(py), 4)],
        }




# =====================================================================  red-team challenge
CHEAT_LIMITS = {"aim_lock": (0.0, 1.0), "smoothing": (0.0, 1.0), "reaction_ms": (40.0, 400.0),
                "reaction_jitter": (0.0, 120.0), "speed_boost": (1.0, 2.5)}
N_TRIALS = 20


def simulate_cheater(p, rng, ticks=300, map_size=1000.0, max_speed=6.0):
    """Same game physics as generate_data.py, but the cheat is designed by the user.
    With every cheat switched off this produces an ordinary human player."""
    a, sm, trig = p["aim_lock"], p["smoothing"], p["auto_trigger"]
    skill = rng.beta(2, 5)
    human_rt = 290 - 110 * skill
    x, y = rng.uniform(0, map_size, 2)
    heading = rng.uniform(0, 2 * np.pi)
    yaw, pitch = rng.uniform(-180, 180), rng.uniform(-10, 10)
    cap = max_speed * p["speed_boost"]
    eff = a * (1 - 0.6 * sm)                 # smoothing hides the snap but weakens the cheat
    rows, shots = [], []
    for t in range(ticks):
        heading += rng.normal(0, 0.25)
        sp = float(np.clip(rng.normal(cap * 0.7, cap * 0.15), 0, cap))
        x = float(np.clip(x + sp * np.cos(heading), 0, map_size))
        y = float(np.clip(y + sp * np.sin(heading), 0, map_size))
        vis = rng.random() < 0.15
        target = yaw + rng.normal(0, 60) if vis else yaw
        corr_h, jit_h = 0.25 + 0.3 * skill, 2.8 - 1.2 * skill
        if vis and a > 0:
            corr = corr_h + (1 - corr_h) * eff
            jit = (jit_h * (1 - a) + 0.3 * a) * (1 - sm) + jit_h * sm
            npitch = pitch + rng.normal(0, 1.2 * (1 - eff) + 0.4 * eff)
        else:
            corr, jit = corr_h, jit_h
            npitch = pitch + rng.normal(0, 1.2)
        ny = yaw + corr * (target - yaw) + rng.normal(0, jit)
        yd = ny - yaw
        yaw, pitch = ny, float(np.clip(npitch, -89, 89))
        fire = vis and rng.random() < 0.8
        rt = max(30.0, rng.normal(p["reaction_ms"], p["reaction_jitter"])) if trig else max(120.0, rng.normal(human_rt - 80 * eff, 55))
        base = 0.22 + 0.33 * skill
        hit = fire and rng.random() < min(base + 0.45 * eff + (0.2 if trig else 0.0), 0.97)
        hs = hit and rng.random() < 0.15 + 0.2 * skill + 0.45 * eff
        rows.append({"match_id": "CHALLENGE", "player_id": "you", "tick": t, "pos_x": x, "pos_y": y, "speed": sp,
                     "yaw": yaw, "pitch": pitch, "yaw_delta": yd, "enemy_visible": int(vis), "is_firing": int(fire),
                     "reaction_ms": rt if fire else np.nan, "is_hit": int(hit), "is_headshot": int(hs), "true_label": "unknown"})
        if vis:
            shots.append({"t": t, "x": round(x, 1), "y": round(y, 1), "aim": round(yaw, 1), "target": round(target, 1),
                          "fire": int(fire), "hit": int(hit), "hs": int(hs)})
    return pd.DataFrame(rows), shots


def cheat_power(feats):
    """How much advantage the cheat gives over a typical honest player (in %)."""
    hm = MODEL.human_medians
    aim = max(0.0, feats["hit_rate"] / hm["hit_rate"] - 1)
    spd = max(0.0, feats["mean_speed"] / hm["mean_speed"] - 1)
    rea = max(0.0, 1 - feats["reaction_mean"] / hm["reaction_mean"])
    return round(100 * (0.5 * aim + 0.3 * spd + 0.2 * rea), 1)


def run_challenge(params, seed=None):
    rng = np.random.default_rng(seed)
    trials = []
    for _ in range(N_TRIALS):
        df, shots = simulate_cheater(params, rng)
        f = extract_features(df).iloc[0]
        feats = {k: round(float(f[k]) if pd.notna(f[k]) else float(MODEL.medians[k]), 4) for k in FEATURES}
        res = MODEL.score(feats)
        trials.append({"feats": feats, "res": res, "df": df, "shots": shots, "power": cheat_power(feats)})
    caught = sum(t["res"]["is_anomaly"] for t in trials)
    detection = caught / N_TRIALS
    power = round(float(np.mean([t["power"] for t in trials])), 1)
    rep = sorted(trials, key=lambda t: t["res"]["score"])[N_TRIALS // 2]     # median match for the replay
    df = rep["df"]
    return {
        "trials": N_TRIALS, "caught": caught, "detection_rate": round(detection, 3),
        "power": power, "evasion_score": round(power * (1 - detection), 1),
        "verdict": "caught" if detection >= 0.5 else "evaded",
        "scores": [round(t["res"]["score"], 3) for t in trials],
        "replay": {"path": df[["pos_x", "pos_y"]].iloc[::2].round(1).values.tolist(), "shots": rep["shots"],
                   "score": rep["res"]["score"], "tier": rep["res"]["tier"], "reasons": rep["res"]["reasons"],
                   "features": rep["feats"], "pca": rep["res"]["pca"]},
    }


# =====================================================================  database
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS scans (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT NOT NULL,
                gamertag    TEXT NOT NULL,
                match_id    TEXT,
                source      TEXT NOT NULL,
                features    TEXT NOT NULL,
                score       REAL NOT NULL,
                tier        TEXT NOT NULL,
                reasons     TEXT NOT NULL
            )""")
        con.execute("""
            CREATE TABLE IF NOT EXISTS challenges (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at      TEXT NOT NULL,
                gamertag        TEXT NOT NULL,
                params          TEXT NOT NULL,
                detection_rate  REAL NOT NULL,
                power           REAL NOT NULL,
                evasion_score   REAL NOT NULL,
                verdict         TEXT NOT NULL
            )""")


def save_scan(gamertag, match_id, source, feats, result):
    with db() as con:
        cur = con.execute(
            "INSERT INTO scans (created_at, gamertag, match_id, source, features, score, tier, reasons) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"), gamertag, match_id, source,
             json.dumps(feats), result["score"], result["tier"], json.dumps(result["reasons"])))
        return cur.lastrowid


def row_to_dict(r):
    d = dict(r)
    d["features"] = json.loads(d["features"])
    d["reasons"] = json.loads(d["reasons"])
    return d


# =====================================================================  app
app = Flask(__name__, static_folder=None)
MODEL = SentinelModel(FEATURES_CSV)
init_db()

TAG_RE = re.compile(r"^[A-Za-z0-9_.\- ]{2,24}$")


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


def bad(msg, code=400):
    return jsonify({"error": msg}), code


def clean_identity(gamertag, match_id):
    gamertag = (gamertag or "").strip()
    match_id = (match_id or "").strip()[:24] or None
    if not TAG_RE.match(gamertag):
        return None, None, "Gamertag must be 2-24 characters: letters, numbers, space, _ . -"
    return gamertag, match_id, None


def respond(gamertag, match_id, source, feats):
    result = MODEL.score(feats)
    scan_id = save_scan(gamertag, match_id, source, feats, result)
    return jsonify({"id": scan_id, "gamertag": gamertag, "match_id": match_id, "source": source,
                    "features": feats, **result})


@app.route("/api/health")
def health():
    with db() as con:
        n = con.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
    return jsonify({"status": "online", "model": "DBSCAN", "scans_saved": n})


@app.route("/api/model")
def model_info():
    return jsonify({
        "algorithm": "DBSCAN", "eps": round(MODEL.eps, 4), "min_samples": MIN_SAMPLES,
        "reference_players": len(MODEL.ref), "normal_core_points": MODEL.n_core,
        "features": [{"key": f, "label": LABELS[f][0], "unit": LABELS[f][1],
                      "min": round(MODEL.ranges[f][0], 4), "max": round(MODEL.ranges[f][1], 4),
                      "default": round(float(MODEL.medians[f]), 4)} for f in FEATURES],
        "presets": {k: {f: round(float(v[f]), 4) for f in FEATURES} for k, v in MODEL.presets.items()},
    })


@app.route("/api/scan", methods=["POST", "OPTIONS"])
def scan():
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json(silent=True) or {}
    gamertag, match_id, err = clean_identity(body.get("gamertag"), body.get("match_id"))
    if err:
        return bad(err)
    raw = body.get("features") or {}
    feats = {}
    for f in FEATURES:
        try:
            v = float(raw[f])
        except (KeyError, TypeError, ValueError):
            return bad(f"Missing or invalid value for '{f}'")
        if not np.isfinite(v) or v < 0:
            return bad(f"'{f}' must be a positive number")
        feats[f] = round(v, 4)
    return respond(gamertag, match_id, "manual", feats)


@app.route("/api/scan/upload", methods=["POST", "OPTIONS"])
def scan_upload():
    """Upload one player's raw match telemetry (same columns as data/raw/player_telemetry.csv).
    The backend runs the SAME preprocessing + feature extraction as the pipeline."""
    if request.method == "OPTIONS":
        return "", 204
    gamertag, match_id, err = clean_identity(request.form.get("gamertag"), request.form.get("match_id"))
    if err:
        return bad(err)
    file = request.files.get("file")
    if not file:
        return bad("Please attach a telemetry .csv file")
    try:
        df = pd.read_csv(io.BytesIO(file.read()))
    except Exception:
        return bad("Could not read that file as CSV")
    need = {"tick", "pos_x", "pos_y", "speed", "yaw_delta", "enemy_visible", "is_firing", "reaction_ms", "is_hit", "is_headshot"}
    missing = need - set(df.columns)
    if missing:
        return bad("CSV is missing columns: " + ", ".join(sorted(missing)))
    if len(df) < 30:
        return bad("Need at least 30 ticks of telemetry to analyse a player")
    df = df.copy()
    df["player_id"] = gamertag
    df["match_id"] = match_id or "UPLOAD"
    df["true_label"] = "unknown"
    df = df.drop_duplicates().sort_values("tick").reset_index(drop=True)
    feats_df = extract_features(df)
    row = feats_df.iloc[0]
    feats = {}
    for f in FEATURES:
        v = row[f]
        feats[f] = round(float(v if pd.notna(v) else MODEL.medians[f]), 4)
    return respond(gamertag, match_id, f"upload ({len(df)} ticks)", feats)


@app.route("/api/scans", methods=["GET", "DELETE", "OPTIONS"])
def scans():
    if request.method == "OPTIONS":
        return "", 204
    if request.method == "DELETE":
        with db() as con:
            con.execute("DELETE FROM scans")
        return jsonify({"deleted": True})
    limit = max(1, min(int(request.args.get("limit", 25)), 200))
    with db() as con:
        rows = con.execute("SELECT * FROM scans ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/api/stats")
def stats():
    with db() as con:
        rows = con.execute("SELECT tier, COUNT(*) n FROM scans GROUP BY tier").fetchall()
    counts = {r["tier"]: r["n"] for r in rows}
    return jsonify({"total": sum(counts.values()), **{t: counts.get(t, 0) for t in ("clean", "review", "high", "critical")}})


@app.route("/api/challenge", methods=["POST", "OPTIONS"])
def challenge():
    """Beat Sentinel: the user designs a cheat, we simulate 20 matches with it and try to catch it."""
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json(silent=True) or {}
    gamertag, _, err = clean_identity(body.get("gamertag"), None)
    if err:
        return bad(err)
    raw = body.get("cheat") or {}
    params = {"auto_trigger": bool(raw.get("auto_trigger", False))}
    for k, (lo, hi) in CHEAT_LIMITS.items():
        try:
            v = float(raw.get(k, lo))
        except (TypeError, ValueError):
            return bad(f"Invalid value for '{k}'")
        params[k] = round(min(hi, max(lo, v)), 4)
    out = run_challenge(params)
    if params["aim_lock"] == 0 and not params["auto_trigger"] and params["speed_boost"] == 1.0:
        out["verdict"] = "honest"      # no cheat enabled: not eligible for the leaderboard
    with db() as con:
        cur = con.execute(
            "INSERT INTO challenges (created_at, gamertag, params, detection_rate, power, evasion_score, verdict) VALUES (?,?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"), gamertag, json.dumps(params),
             out["detection_rate"], out["power"], out["evasion_score"], out["verdict"]))
        cid = cur.lastrowid
        rank = con.execute("SELECT COUNT(*) FROM challenges WHERE evasion_score > ?", (out["evasion_score"],)).fetchone()[0] + 1
    return jsonify({"id": cid, "gamertag": gamertag, "cheat": params, "rank": rank, **out})


@app.route("/api/leaderboard")
def leaderboard():
    with db() as con:
        fame = con.execute("SELECT * FROM challenges WHERE verdict='evaded' AND power > 0 ORDER BY evasion_score DESC, id LIMIT 10").fetchall()
        shame = con.execute("SELECT * FROM challenges WHERE verdict='caught' ORDER BY power DESC, id DESC LIMIT 10").fetchall()
        tot = con.execute("SELECT COUNT(*), SUM(verdict='caught') FROM challenges").fetchone()
    conv = lambda r: {**dict(r), "params": json.loads(r["params"])}
    return jsonify({"hall_of_fame": [conv(r) for r in fame], "wall_of_shame": [conv(r) for r in shame],
                    "attempts": tot[0] or 0, "caught": tot[1] or 0})


# ---------- serve the website ----------
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  Sentinel AI backend running ->  http://localhost:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=False)
