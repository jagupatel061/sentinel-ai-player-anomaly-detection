"""
Spectator - Anomaly Detection Pipeline (DBSCAN)
=================================================
Stages (matches the project deliverables):
  1. Data preparation      -> load, clean, handle missing values
  2. Feature extraction    -> per-player behavioural fingerprint (10 features)
  3. Anomaly detection     -> StandardScaler + DBSCAN (eps chosen from k-distance knee)
  4. Anomaly scoring       -> distance-based score, 0 (normal) .. 1+ (highly anomalous)
  5. Evaluation            -> precision / recall / F1 / confusion matrix vs. hidden labels
  6. Sensitivity analysis  -> DBSCAN re-run over a grid of eps x min_samples
  7. Benchmark             -> DBSCAN vs Isolation Forest, LOF, One-Class SVM, K-Means
  8. Export                -> CSVs, JSON for the website, and report plots

Run from the repo root:  python backend/pipeline.py
"""

import json
import os
import time

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN, KMeans
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.neighbors import LocalOutlierFactor
from sklearn.svm import OneClassSVM
from sklearn.metrics import (confusion_matrix, f1_score, precision_score,
                             recall_score, silhouette_score)
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

RAW_PATH = os.path.join("data", "raw", "player_telemetry.csv")
PROC_DIR = os.path.join("data", "processed")
FIG_DIR = os.path.join("docs", "figures")
WEB_DIR = os.path.join("frontend", "public", "data")

MIN_SAMPLES = 5          # DBSCAN: min neighbours to form a dense "normal" region
MICRO_FRAC = 0.10        # clusters smaller than 10% of players = suspicious micro-clusters

FEATURES = [
    "mean_speed",        # average movement speed
    "max_speed",         # peak movement speed (speedhack)
    "speed_std",         # movement variability
    "snap_angle",        # mean |yaw change| when an enemy appears (aimbot flicks)
    "aim_jitter",        # std of yaw change while idle (human hand noise)
    "reaction_mean",     # average reaction time in ms
    "reaction_std",      # reaction consistency (bots are too consistent)
    "hit_rate",          # hits / shots fired
    "headshot_rate",     # headshots / hits
    "path_straightness", # displacement / distance travelled
]


# ----------------------------------------------------------------- 1. prepare
def load_and_clean(path):
    df = pd.read_csv(path)
    before = len(df)
    df = df.drop_duplicates()
    df = df.sort_values(["player_id", "tick"]).reset_index(drop=True)
    # reaction_ms only exists when firing -> NaN otherwise (expected, not dirty)
    info = {
        "rows": int(before),
        "rows_after_cleaning": int(len(df)),
        "players": int(df["player_id"].nunique()),
        "matches": int(df["match_id"].nunique()),
        "columns": list(df.columns),
        "missing_reaction_pct": round(float(df["reaction_ms"].isna().mean() * 100), 1),
    }
    return df, info


# ----------------------------------------------------------------- 2. features
def extract_features(df):
    rows = []
    for pid, g in df.groupby("player_id", sort=False):
        visible = g[g["enemy_visible"] == 1]
        idle = g[g["enemy_visible"] == 0]
        fired = g[g["is_firing"] == 1]
        hits = g["is_hit"].sum()

        step = np.hypot(np.diff(g["pos_x"]), np.diff(g["pos_y"]))
        travelled = step.sum()
        displacement = np.hypot(g["pos_x"].iloc[-1] - g["pos_x"].iloc[0],
                                g["pos_y"].iloc[-1] - g["pos_y"].iloc[0])

        rows.append({
            "player_id": pid,
            "match_id": g["match_id"].iloc[0],
            "mean_speed": g["speed"].mean(),
            "max_speed": g["speed"].max(),
            "speed_std": g["speed"].std(),
            "snap_angle": visible["yaw_delta"].abs().mean() if len(visible) else 0.0,
            "aim_jitter": idle["yaw_delta"].std(),
            "reaction_mean": fired["reaction_ms"].mean() if len(fired) else np.nan,
            "reaction_std": fired["reaction_ms"].std() if len(fired) > 1 else np.nan,
            "hit_rate": hits / len(fired) if len(fired) else 0.0,
            "headshot_rate": g["is_headshot"].sum() / hits if hits else 0.0,
            "path_straightness": displacement / travelled if travelled else 0.0,
            "true_label": g["true_label"].iloc[0],   # kept aside for evaluation
        })
    feats = pd.DataFrame(rows)
    feats[FEATURES] = feats[FEATURES].fillna(feats[FEATURES].median())
    return feats


# ----------------------------------------------------------------- 3. DBSCAN
def choose_eps(X, k=MIN_SAMPLES):
    """k-distance 'knee': the point of max curvature on the sorted k-NN distance curve."""
    nn = NearestNeighbors(n_neighbors=k).fit(X)
    dist, _ = nn.kneighbors(X)
    kd = np.sort(dist[:, -1])
    # knee = point farthest from the straight line joining first and last points
    n = len(kd)
    line = np.linspace(kd[0], kd[-1], n)
    knee_idx = int(np.argmax(line - kd))
    return float(kd[knee_idx]), kd, knee_idx


def run_dbscan(feats):
    scaler = StandardScaler()
    X = scaler.fit_transform(feats[FEATURES])
    eps, kd, knee_idx = choose_eps(X)
    model = DBSCAN(eps=eps, min_samples=MIN_SAMPLES).fit(X)
    labels = model.labels_

    # ------------------------------------------------------- 4. anomaly score
    # Two kinds of DBSCAN anomaly:
    #   noise         : label -1, belongs to no dense region (lone cheater)
    #   micro-cluster : a dense but SMALL cluster (< MICRO_FRAC of players) -
    #                   a group of players sharing the same inhuman pattern (same cheat tool)
    sizes = pd.Series(labels[labels != -1]).value_counts()
    normal_clusters = set(sizes[sizes >= MICRO_FRAC * len(labels)].index)
    kind = np.where(labels == -1, "noise",
                    np.where(np.isin(labels, list(normal_clusters)), "normal", "micro-cluster"))

    # score = distance to nearest core point of a NORMAL cluster, divided by eps
    # <= 1 : inside normal behaviour     > 1 : outside it (the larger, the stranger)
    core_idx = [i for i in model.core_sample_indices_ if labels[i] in normal_clusters]
    d_core = NearestNeighbors(n_neighbors=1).fit(X[core_idx]).kneighbors(X)[0][:, 0]
    score = d_core / eps

    feats = feats.copy()
    feats["cluster"] = labels
    feats["anomaly_type"] = kind
    feats["is_anomaly"] = (kind != "normal").astype(int)
    feats["anomaly_score"] = np.round(score, 4)

    # which feature pushed each anomaly out? (largest |z-score|)
    z = pd.DataFrame(X, columns=FEATURES)
    feats["top_reason"] = z.abs().idxmax(axis=1)
    feats["top_reason_z"] = np.round(z.abs().max(axis=1), 2)
    return feats, X, eps, kd, knee_idx


# ----------------------------------------------------------------- 5. evaluate
def evaluate(feats, X):
    y_true = (feats["true_label"] != "human").astype(int)
    y_pred = feats["is_anomaly"]
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    per_type = (feats[feats["true_label"] != "human"]
                .groupby("true_label")["is_anomaly"].agg(["sum", "count"]))
    clustered = feats["cluster"] != -1
    sil = (silhouette_score(X[clustered], feats.loc[clustered, "cluster"])
           if feats.loc[clustered, "cluster"].nunique() > 1 else None)
    return {
        "precision": round(float(precision_score(y_true, y_pred, zero_division=0)), 3),
        "recall": round(float(recall_score(y_true, y_pred, zero_division=0)), 3),
        "f1": round(float(f1_score(y_true, y_pred, zero_division=0)), 3),
        "accuracy": round(float((tp + tn) / len(y_true)), 3),
        "confusion": {"tp": int(tp), "fp": int(fp), "tn": int(tn), "fn": int(fn)},
        "per_type_recall": {k: round(float(v["sum"] / v["count"]), 3) for k, v in per_type.iterrows()},
        "silhouette": None if sil is None else round(float(sil), 3),
    }



# ----------------------------------------------------------------- 6. sensitivity
def dbscan_flags(X, eps, min_samples):
    """Run DBSCAN and return anomaly flags using the same noise + micro-cluster rule."""
    labels = DBSCAN(eps=eps, min_samples=min_samples).fit(X).labels_
    sizes = pd.Series(labels[labels != -1]).value_counts()
    normal = set(sizes[sizes >= MICRO_FRAC * len(labels)].index)
    flags = ~np.isin(labels, list(normal))
    n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
    return flags.astype(int), n_clusters


def prf(y_true, y_pred):
    return (round(float(precision_score(y_true, y_pred, zero_division=0)), 3),
            round(float(recall_score(y_true, y_pred, zero_division=0)), 3),
            round(float(f1_score(y_true, y_pred, zero_division=0)), 3))


def sensitivity(feats, X):
    """Grid of DBSCAN runs. Stored so the website's Parameter Lab responds instantly."""
    y = (feats["true_label"] != "human").astype(int).values
    eps_grid = [round(e, 2) for e in np.arange(0.6, 4.01, 0.1)]
    ms_grid = [3, 4, 5, 6, 8, 10]
    runs = []
    for ms in ms_grid:
        for e in eps_grid:
            flags, nc = dbscan_flags(X, e, ms)
            p, r, f = prf(y, flags)
            runs.append({"eps": e, "min_samples": ms, "precision": p, "recall": r, "f1": f,
                         "flagged": int(flags.sum()), "clusters": int(nc),
                         "anomalies": [int(i) for i in np.where(flags == 1)[0]]})
    return {"eps_grid": eps_grid, "min_samples_grid": ms_grid, "runs": runs}


# ----------------------------------------------------------------- 7. benchmark
RATES = [0.05, 0.12, 0.20]   # guessed cheat rates given to methods that need one


def benchmark(feats, X, dbscan_pred):
    """Compare DBSCAN with other unsupervised detectors.
    Every other method must be TOLD the expected anomaly rate (contamination). In real life that
    rate is unknown, so each is tested with a low (5%), correct-ish (12%) and high (20%) guess.
    DBSCAN needs no such guess."""
    y = (feats["true_label"] != "human").astype(int).values

    def kmeans_pred(rate):
        km = KMeans(n_clusters=3, n_init=10, random_state=42).fit(X)
        d = np.linalg.norm(X - km.cluster_centers_[km.labels_], axis=1)
        return (d >= np.quantile(d, 1 - rate)).astype(int)

    methods = [
        ("Isolation Forest", "Random partitioning trees",
         lambda r: (IsolationForest(contamination=r, random_state=42).fit_predict(X) == -1).astype(int)),
        ("Local Outlier Factor", "Local density ratio",
         lambda r: (LocalOutlierFactor(n_neighbors=20, contamination=r).fit_predict(X) == -1).astype(int)),
        ("One-Class SVM", "Boundary around normal data",
         lambda r: (OneClassSVM(nu=r, gamma="scale").fit(X).predict(X) == -1).astype(int)),
        ("K-Means distance", "Far from nearest centroid", kmeans_pred),
    ]
    p, r, f = prf(y, np.asarray(dbscan_pred))
    out = [{"method": "DBSCAN", "note": "Density-based · finds outliers itself", "needs_contamination": False,
            "precision": p, "recall": r, "f1": f, "flagged": int(np.sum(dbscan_pred)),
            "by_rate": {str(rt): f for rt in RATES}, "f1_mean": f, "f1_min": f}]
    for name, note, fn in methods:
        by = {}
        for rt in RATES:
            pred = fn(rt)
            by[str(rt)] = prf(y, pred)[2]
            if rt == 0.12:
                p, r, f = prf(y, pred); flagged = int(pred.sum())
        vals = list(by.values())
        out.append({"method": name, "note": note, "needs_contamination": True, "precision": p, "recall": r,
                    "f1": f, "flagged": flagged, "by_rate": by,
                    "f1_mean": round(float(np.mean(vals)), 3), "f1_min": round(float(np.min(vals)), 3)})
    return out


# ----------------------------------------------------------------- 8. plots
def make_plots(feats, X, kd, knee_idx, eps):
    os.makedirs(FIG_DIR, exist_ok=True)
    plt.style.use("dark_background")
    accent, danger = "#7CF5FF", "#FF4D8D"

    # k-distance plot
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(kd, color=accent, lw=2)
    ax.axhline(eps, color=danger, ls="--", label=f"eps = {eps:.2f}")
    ax.scatter([knee_idx], [kd[knee_idx]], color=danger, zorder=5)
    ax.set(title="k-distance graph (choosing eps)", xlabel="Players sorted by distance",
           ylabel=f"Distance to {MIN_SAMPLES}th neighbour")
    ax.legend(); fig.tight_layout(); fig.savefig(os.path.join(FIG_DIR, "k_distance.png"), dpi=150)
    plt.close(fig)

    # PCA projection
    p = PCA(n_components=2).fit_transform(X)
    fig, ax = plt.subplots(figsize=(7, 5))
    n = feats["is_anomaly"] == 0
    ax.scatter(p[n, 0], p[n, 1], s=18, color=accent, alpha=.7, label="Normal")
    ax.scatter(p[~n, 0], p[~n, 1], s=60, color=danger, marker="x", label="Anomaly (flagged by DBSCAN)")
    ax.set(title="Player behaviour space (PCA 2D)", xlabel="PC1", ylabel="PC2")
    ax.legend(); fig.tight_layout(); fig.savefig(os.path.join(FIG_DIR, "pca_clusters.png"), dpi=150)
    plt.close(fig)

    # anomaly score distribution
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.hist(feats.loc[n, "anomaly_score"], bins=30, color=accent, alpha=.8, label="Normal")
    ax.hist(feats.loc[~n, "anomaly_score"], bins=30, color=danger, alpha=.8, label="Anomaly")
    ax.axvline(1.0, color="white", ls="--", lw=1)
    ax.set(title="Anomaly score distribution", xlabel="Score (distance / eps)", ylabel="Players")
    ax.legend(); fig.tight_layout(); fig.savefig(os.path.join(FIG_DIR, "score_hist.png"), dpi=150)
    plt.close(fig)
    return p



def plot_extra(sens, bench):
    plt.style.use("dark_background")
    accent, danger, violet = "#7CF5FF", "#FF4D8D", "#A07CFF"
    runs = [r for r in sens["runs"] if r["min_samples"] == MIN_SAMPLES]
    e = [r["eps"] for r in runs]
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(e, [r["precision"] for r in runs], color=violet, lw=2, label="Precision")
    ax.plot(e, [r["recall"] for r in runs], color=danger, lw=2, label="Recall")
    ax.plot(e, [r["f1"] for r in runs], color=accent, lw=2.5, label="F1")
    ax.set(title=f"Sensitivity to eps (min_samples = {MIN_SAMPLES})", xlabel="eps", ylabel="score", ylim=(0, 1.05))
    ax.legend(); fig.tight_layout(); fig.savefig(os.path.join(FIG_DIR, "eps_sensitivity.png"), dpi=150)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(8, 4.2))
    names = [b["method"] for b in bench]
    w = 0.26
    cols = ["#FFC24B", accent, violet]
    for k, rt in enumerate(RATES):
        vals = [b["by_rate"][str(rt)] for b in bench]
        ax.bar(np.arange(len(names)) + (k - 1) * w, vals, w, color=cols[k], label=f"guessed rate {int(rt * 100)}%")
    ax.set_xticks(np.arange(len(names)), [n.replace(" ", "\n", 1) for n in names], fontsize=9)
    ax.set(title="F1 when the cheat rate must be guessed (DBSCAN needs no guess)", ylabel="F1", ylim=(0, 1.1))
    ax.legend(fontsize=8); fig.tight_layout(); fig.savefig(os.path.join(FIG_DIR, "benchmark.png"), dpi=150)
    plt.close(fig)


# ----------------------------------------------------------------- main
def main():
    for d in (PROC_DIR, FIG_DIR, WEB_DIR):
        os.makedirs(d, exist_ok=True)

    df, info = load_and_clean(RAW_PATH)
    print(f"[1] Loaded {info['rows']:,} rows | {info['players']} players | {info['matches']} matches")

    feats = extract_features(df)
    print(f"[2] Extracted {len(FEATURES)} behavioural features per player")

    feats, X, eps, kd, knee_idx = run_dbscan(feats)
    n_clusters = len(set(feats["cluster"])) - (1 if -1 in feats["cluster"].values else 0)
    print(f"[3] DBSCAN eps={eps:.3f} min_samples={MIN_SAMPLES} -> "
          f"{n_clusters} cluster(s), {feats['is_anomaly'].sum()} anomalies")

    metrics = evaluate(feats, X)
    print(f"[4] Precision={metrics['precision']}  Recall={metrics['recall']}  F1={metrics['f1']}")
    print(f"    Per cheat type recall: {metrics['per_type_recall']}")

    sens = sensitivity(feats, X)
    print(f"[5] Sensitivity analysis: {len(sens['runs'])} DBSCAN runs over eps x min_samples")

    bench = benchmark(feats, X, feats["is_anomaly"].values)
    print("    method                 F1 @5%   F1 @12%  F1 @20%  (guessed cheat rate)")
    for b in bench:
        r = b["by_rate"]
        print(f"    {b['method']:<22} {r['0.05']:.3f}    {r['0.12']:.3f}    {r['0.2']:.3f}")

    pca = make_plots(feats, X, kd, knee_idx, eps)
    plot_extra(sens, bench)
    feats["pca_x"], feats["pca_y"] = np.round(pca[:, 0], 4), np.round(pca[:, 1], 4)

    feats.to_csv(os.path.join(PROC_DIR, "player_features.csv"), index=False)

    # sample trajectories for the website map (every 3rd tick keeps the file small)
    traj = {pid: g[["pos_x", "pos_y"]].iloc[::3].round(1).values.tolist()
            for pid, g in df.groupby("player_id")}

    web = {
        "dataset": info,
        "model": {"algorithm": "DBSCAN", "eps": round(eps, 4), "min_samples": MIN_SAMPLES,
                  "features": FEATURES, "n_clusters": int(n_clusters),
                  "k_distance": np.round(kd, 4).tolist(), "knee_index": knee_idx},
        "metrics": metrics,
        "sensitivity": sens,
        "benchmark": bench,
        "players": json.loads(feats.round(4).to_json(orient="records")),
        "trajectories": traj,
    }
    with open(os.path.join(WEB_DIR, "results.json"), "w") as f:
        json.dump(web, f)
    print(f"[6] Saved results -> {WEB_DIR}/results.json, plots -> {FIG_DIR}/")


if __name__ == "__main__":
    main()
