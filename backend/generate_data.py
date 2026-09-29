"""
Sentinel AI — Synthetic Player Telemetry Generator
---------------------------------------------------
Simulates in-game movement + aim telemetry for multiplayer matches.

Player types:
  - human      : natural movement, noisy aim, human reaction times
                 (each human has a skill level, so some "pro" players look suspicious)
  - aimbot     : "snap" aim flicks and high accuracy; some are subtle "closet" cheaters
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

    # --- per-player personality (makes the data realistic, not perfectly separable) ---
    skill = RNG.beta(2, 5)               # 0 = casual, 1 = pro. A few humans are very good.
    speed_cap = MAX_HUMAN_SPEED * (RNG.uniform(1.25, 2.4) if ptype == "speedhack" else 1.0)
    bot_reaction = RNG.uniform(60, 110)  # triggerbot: fixed, inhuman reaction (ms)
    lock = RNG.uniform(0.55, 1.0)        # aimbot strength: <0.7 = "closet" cheater (humanised)
    human_rt = 290 - 110 * skill         # pros react faster

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
            # lock-on: snaps `lock` of the way to target, with tiny jitter
            new_yaw = yaw + lock * (target_yaw - yaw) + RNG.normal(0, 3 * (1 - lock) + 0.3)
            new_pitch = pitch + RNG.normal(0, 0.4)
        else:
            # humans: partial correction toward target + hand jitter (pros are steadier)
            corr = 0.25 + 0.3 * skill
            new_yaw = yaw + corr * (target_yaw - yaw) + RNG.normal(0, 2.8 - 1.2 * skill)
            new_pitch = pitch + RNG.normal(0, 1.2)

        yaw_delta = new_yaw - yaw
        yaw, pitch = new_yaw, float(np.clip(new_pitch, -89, 89))

        # --- shooting ---
        is_firing = enemy_visible and RNG.random() < 0.8
        if ptype == "triggerbot":
            reaction_ms = bot_reaction + RNG.normal(0, 8)
        elif ptype == "aimbot":
            reaction_ms = max(90, RNG.normal(human_rt - 80 * lock, 30))
        else:
            reaction_ms = max(120, RNG.normal(human_rt, 55))

        base_hit = 0.22 + 0.33 * skill                     # humans: 22% .. 55%
        hit_prob = {"aimbot": base_hit + 0.45 * lock,
                    "triggerbot": base_hit + 0.2}.get(ptype, base_hit)
        is_hit = is_firing and RNG.random() < min(hit_prob, 0.97)
        hs_prob = 0.15 + 0.2 * skill + (0.45 * lock if ptype == "aimbot" else 0)
        headshot = is_hit and RNG.random() < hs_prob

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