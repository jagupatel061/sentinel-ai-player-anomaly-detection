"""
Sentinel AI — Synthetic Player Telemetry Generator
---------------------------------------------------
Simulates in-game movement + aim telemetry for multiplayer matches.

Player types:
  - human      : natural movement, smooth-but-noisy aim, human reaction times
  - aimbot     : instant "snap" aim flicks, near-zero jitter, inhuman accuracy
  - speedhack  : movement speed far above the game's max
  - triggerbot : normal movement, but fires with robotic, constant reaction time

The `true_label` column is ONLY used later for evaluation.
DBSCAN never sees it (unsupervised anomaly detection).

Output: data/raw/player_telemetry.csv
Run from the repo root:  python backend/generate_data.py
"""

import os
import numpy as np
import pandas as pd

RNG = np.random.default_rng(42)          # fixed seed -> reproducible results

N_MATCHES = 20
PLAYERS_PER_MATCH = 10
TICKS_PER_PLAYER = 300                   # 300 ticks ~ 30 s at 10 Hz
MAP_SIZE = 1000.0
MAX_HUMAN_SPEED = 6.0                    # units per tick

# ~88% humans, ~12% cheaters (anomalies should be rare)
TYPE_WEIGHTS = {"human": 0.88, "aimbot": 0.05, "speedhack": 0.04, "triggerbot": 0.03}


def simulate_player(player_id, match_id, ptype):
    rows = []
    x, y = RNG.uniform(0, MAP_SIZE, 2)
    heading = RNG.uniform(0, 2 * np.pi)
    yaw, pitch = RNG.uniform(-180, 180), RNG.uniform(-10, 10)

    speed_cap = MAX_HUMAN_SPEED * (RNG.uniform(1.8, 2.6) if ptype == "speedhack" else 1.0)
    bot_reaction = RNG.uniform(40, 70)   # triggerbot: fixed, inhuman reaction (ms)

    for tick in range(TICKS_PER_PLAYER):
        # --- movement: random walk with momentum ---
        heading += RNG.normal(0, 0.25)
        speed = np.clip(RNG.normal(speed_cap * 0.7, speed_cap * 0.15), 0, speed_cap)
        x = np.clip(x + speed * np.cos(heading), 0, MAP_SIZE)
        y = np.clip(y + speed * np.sin(heading), 0, MAP_SIZE)

        # --- aim behaviour ---
        enemy_visible = RNG.random() < 0.15
        target_yaw = yaw + RNG.normal(0, 60) if enemy_visible else yaw

        if ptype == "aimbot" and enemy_visible:
            new_yaw = target_yaw + RNG.normal(0, 0.3)          # instant lock-on
            new_pitch = pitch + RNG.normal(0, 0.2)
        else:
            # humans: partial correction toward target + hand jitter
            new_yaw = yaw + 0.35 * (target_yaw - yaw) + RNG.normal(0, 2.5)
            new_pitch = pitch + RNG.normal(0, 1.2)

        yaw_delta = new_yaw - yaw
        yaw, pitch = new_yaw, float(np.clip(new_pitch, -89, 89))

        # --- shooting ---
        is_firing = enemy_visible and RNG.random() < 0.8
        if ptype == "triggerbot":
            reaction_ms = bot_reaction + RNG.normal(0, 3)
        elif ptype == "aimbot":
            reaction_ms = RNG.normal(90, 10)
        else:
            reaction_ms = max(120, RNG.normal(250, 60))

        hit_prob = {"aimbot": 0.9, "triggerbot": 0.75}.get(ptype, 0.28)
        is_hit = is_firing and RNG.random() < hit_prob
        headshot = is_hit and RNG.random() < (0.7 if ptype == "aimbot" else 0.2)

        rows.append({
            "match_id": match_id,
            "player_id": player_id,
            "tick": tick,
            "pos_x": round(x, 2),
            "pos_y": round(y, 2),
            "speed": round(speed, 3),
            "yaw": round(yaw, 3),
            "pitch": round(pitch, 3),
            "yaw_delta": round(yaw_delta, 3),
            "enemy_visible": int(enemy_visible),
            "is_firing": int(is_firing),
            "reaction_ms": round(reaction_ms, 1) if is_firing else np.nan,
            "is_hit": int(is_hit),
            "is_headshot": int(headshot),
            "true_label": ptype,          # evaluation only — NOT a model input
        })
    return rows


def main():
    types = list(TYPE_WEIGHTS)
    probs = list(TYPE_WEIGHTS.values())
    all_rows = []

    for m in range(N_MATCHES):
        match_id = f"M{m + 1:03d}"
        for p in range(PLAYERS_PER_MATCH):
            player_id = f"{match_id}_P{p + 1:02d}"
            ptype = RNG.choice(types, p=probs)
            all_rows.extend(simulate_player(player_id, match_id, ptype))

    df = pd.DataFrame(all_rows)
    out_dir = os.path.join("data", "raw")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "player_telemetry.csv")
    df.to_csv(out_path, index=False)

    players = df.groupby("player_id")["true_label"].first().value_counts()
    print(f"Saved {len(df):,} rows -> {out_path}")
    print("Players per type:\n", players.to_string())


if __name__ == "__main__":
    main()
