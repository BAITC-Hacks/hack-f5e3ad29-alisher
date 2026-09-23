#!/usr/bin/env python3
"""Роли, кластеры и приоритеты проверки по графу переводов.

Главная идея: оцениваем, сколько денег seed (метод haircut с учётом дат) дошло
до каждого клиента, и ставим первыми узлы, где эти деньги сходятся.
Запуск из любой директории: python /path/to/analysis/run.py
Формулы, пороги и ограничения описаны в analysis/README.md.
"""

from time import perf_counter

STARTED = perf_counter()  # включает импорт зависимостей при запуске скрипта

import argparse
from collections import Counter, deque
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
from pandas.api.types import is_bool_dtype, is_integer_dtype, is_numeric_dtype

SCRIPT_DIR = Path(__file__).resolve().parent
PERIOD_START = pd.Timestamp("2026-07-01")
PERIOD_END = pd.Timestamp("2026-07-31")
EARLY_END = pd.Timestamp("2026-07-24")  # за 7 дней до конца: позже выход мог не попасть в выгрузку

# Пороги выбраны по смыслу до расчёта, а не подобраны под известные gid.
MIN_TX_KZT = 5_000        # порог выгрузки; вклад seed меньше него не считается источником
MATERIAL_KZT = 100_000    # отделяет существенный оборот от единичных мелких переводов
FAST_DAYS = 2             # сквозной транзит: выход в тот же день или через 1–2 дня
SYNC_PAYERS = 3           # синхронный сбор: 3+ разных плательщика в один день
SPLIT_TX = 3              # дробление: 3+ перевода одному получателю в один день
FAN_OUT = 10              # отправитель-«веер» при сравнении узлов 4-го колена
BOUNDARY_TERMINAL = 0.75  # доля похожих узлов, оставивших деньги, для гипотезы terminal на 4-м колене
BOUNDARY_MIN_SIMILAR = 100
BOUNDARY_CAP = 0.35       # потолок поддержки на 4-м колене: выход не наблюдается

LOUVAIN_SEED = 42
STABILITY_RUNS = 20
RESILIENCE_TOP = (5, 10, 20, 30)

ROLES = ("coordinator", "consolidator", "distributor", "transit", "terminal", "peripheral")
ROLE_RU = {"coordinator": "координация", "consolidator": "сбор", "distributor": "веер",
           "transit": "транзит", "terminal": "конечный получатель", "peripheral": "периферия"}
ROLE_WEIGHTS = {"coordinator": 1.0, "consolidator": 0.9, "transit": 0.7, "terminal": 0.7,
                "distributor": 0.6, "peripheral": 0.0}
PRIORITY_WEIGHTS = {"money": 0.5, "sources": 0.2, "role": 0.3}
PATTERNS = ("seed", "isolated", "boundary", "external_funding", "fast_transit", "sync_inflow",
            "split", "return_flow", "stable_route", "late_inflow")

NODE_COLUMNS = ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"]
CLUSTER_COLUMNS = ["cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"]
TOP_COLUMNS = ["rank", "gid", "role", "priority_score", "why"]


def require(condition, message):
    """Проверки действуют и при python -O."""
    if not condition:
        raise ValueError(message)


# ---------------------------------------------------------------- данные и граф

def load(data_dir):
    edges = pd.read_parquet(data_dir / "edges.parquet")
    nodes = pd.read_parquet(data_dir / "nodes.parquet")
    tx = pd.read_parquet(data_dir / "transactions.parquet")
    tx["date"] = pd.to_datetime(tx["date"], errors="raise")
    # Канонический порядок исключает зависимость от порядка строк Parquet.
    return (edges.sort_values(["src", "dst"]).reset_index(drop=True),
            nodes.sort_values("gid").reset_index(drop=True),
            tx.sort_values(["date", "src", "dst", "sum_kzt"]).reset_index(drop=True))


def sanity_check(edges, nodes, tx):
    for name, frame, columns in (
        ("nodes", nodes, ["gid", "depth", "is_seed"]),
        ("edges", edges, ["src", "dst", "sum_kzt", "n_tx", "depth"]),
        ("transactions", tx, ["src", "dst", "date", "sum_kzt"]),
    ):
        require(set(columns) <= set(frame.columns), f"{name}: неполная схема")
        require(not frame[columns].isna().any().any(), f"{name}: пропуски")
        for col in set(columns) & {"gid", "src", "dst", "depth", "n_tx"}:
            require(is_integer_dtype(frame[col]), f"{name}.{col}: требуется целое число")
    require(len(nodes) > 0 and nodes.gid.is_unique, "nodes: пустой список или дубликаты gid")
    require(is_bool_dtype(nodes.is_seed), "is_seed должен быть bool")
    require(nodes.depth.between(0, 4).all(), "Некорректная глубина узла")
    require((nodes.is_seed == nodes.depth.eq(0)).all(), "Seed должен иметь depth=0")
    require(edges.depth.between(1, 4).all(), "Некорректная глубина ребра")
    require(not edges.duplicated(["src", "dst"]).any(), "Дубликаты рёбер")
    require((edges.n_tx > 0).all(), "Неположительное n_tx")
    gids = set(nodes.gid)
    for name, frame in (("edges", edges), ("transactions", tx)):
        require(set(frame.src) | set(frame.dst) <= gids, f"{name}: неизвестный gid")
        require(is_numeric_dtype(frame.sum_kzt) and np.isfinite(frame.sum_kzt).all(),
                f"{name}: некорректные суммы")
        require((frame.sum_kzt >= MIN_TX_KZT).all(), f"{name}: сумма ниже порога выгрузки")
    require(tx.date.between(PERIOD_START, PERIOD_END).all(), "Дата вне июля 2026")
    agg = tx.groupby(["src", "dst"]).agg(s=("sum_kzt", "sum"), c=("sum_kzt", "size"))
    merged = edges.merge(agg, on=["src", "dst"], how="outer", indicator=True,
                         validate="one_to_one")
    require(merged._merge.eq("both").all(), "edges/transactions: разные пары")
    require(np.allclose(merged.sum_kzt, merged.s, rtol=0, atol=0.01),
            "edges/transactions: разные суммы (допуск 0.01 KZT)")
    require(merged.n_tx.eq(merged.c).all(), "edges/transactions: разное число транзакций")


def build_graph(edges, nodes):
    graph = nx.DiGraph()
    # Источник полного реестра — nodes, включая изолированные seed.
    graph.add_nodes_from(sorted(int(gid) for gid in nodes.gid))
    for r in edges.itertuples(index=False):
        graph.add_edge(r.src, r.dst, sum_kzt=float(r.sum_kzt), n_tx=int(r.n_tx))
    return graph


# ---------------------------------------------------------------- кластеры

def louvain(undirected, seed):
    return nx.community.louvain_communities(undirected, weight="weight", resolution=1.0,
                                            threshold=1e-7, seed=seed)


def assign_clusters(graph):
    """Louvain на сумме двух направлений; роли считаются по DiGraph.

    Возвращает номер кластера каждого gid и устойчивость кластера: средний лучший
    Jaccard с сообществами тех же данных при STABILITY_RUNS других random seed.
    """
    undirected = nx.Graph()
    undirected.add_nodes_from(graph.nodes)
    for src, dst, data in graph.edges(data=True):
        previous = undirected.get_edge_data(src, dst, {}).get("weight", 0.0)
        undirected.add_edge(src, dst, weight=previous + data["sum_kzt"])
    isolates = set(nx.isolates(undirected))
    active = undirected.subgraph([gid for gid in undirected if gid not in isolates]).copy()
    communities = louvain(active, LOUVAIN_SEED) if active.number_of_edges() else []
    communities.extend({gid} for gid in sorted(isolates))
    communities.sort(key=lambda group: (-len(group), min(group)))
    runs = []
    for seed in range(STABILITY_RUNS if active.number_of_edges() else 0):
        labels = {gid: index for index, group in enumerate(louvain(active, seed)) for gid in group}
        runs.append((labels, Counter(labels.values())))
    stability = {}
    for cluster_id, group in enumerate(communities, start=1):
        if group <= isolates:
            stability[cluster_id] = 1.0  # одиночный узел без рёбер выделяется всегда
            continue
        scores = []
        for labels, sizes in runs:
            overlap = Counter(labels[gid] for gid in group)
            scores.append(max(n / (len(group) + sizes[label] - n) for label, n in overlap.items()))
        stability[cluster_id] = float(np.mean(scores))
    cluster_map = {gid: index for index, group in enumerate(communities, start=1) for gid in group}
    return cluster_map, stability


# ---------------------------------------------------------------- деньги seed

def seed_money(tx, nodes, blocked=()):
    """Деньги seed по методу haircut с учётом дат (README, «Деньги seed»).

    Счёт клиента — котёл из наблюдаемых поступлений. Перевод уносит из котла долю
    денег каждого seed, равную их доле в котле. Если перевод больше котла, недостающее —
    невидимые деньги: у seed это его собственные деньги seed, у остальных — чистые.
    Порядок внутри дня неизвестен, поэтому поступления дня доступны переводам того же дня.
    Переводы узлов из blocked исключаются (сценарий блокировки).
    """
    gids = nodes.gid.to_numpy()
    position = pd.Series(np.arange(len(gids)), index=gids)
    own = np.full(len(gids), -1)
    seed_rows = np.flatnonzero(nodes.is_seed.to_numpy())
    own[seed_rows] = np.arange(len(seed_rows))
    n, s = len(gids), len(seed_rows)
    tx = tx[~tx.src.isin(set(blocked))]
    src, dst = position[tx.src].to_numpy(), position[tx.dst].to_numpy()
    amount, days = tx.sum_kzt.to_numpy(float), tx.date.to_numpy()
    pool, pool_seed = np.zeros(n), np.zeros((n, s))
    received, sent = np.zeros((n, s)), np.zeros((n, s))
    origin, unobserved, tx_seed = np.zeros(n), np.zeros(n), np.zeros(len(tx))
    for day in np.unique(days):
        rows = np.flatnonzero(days == day)
        u, v, a = src[rows], dst[rows], amount[rows]
        out_today, in_today = np.bincount(u, a, n), np.bincount(v, a, n)
        available = pool + in_today
        funded = np.maximum(available, out_today)
        by_seed = own[u] >= 0
        incoming = np.zeros((n, s))
        # Цепочки внутри дня зависят друг от друга: итерация до неподвижной точки.
        for _ in range(200):
            share = np.divide(pool_seed + incoming, funded[:, None], out=np.zeros((n, s)),
                              where=funded[:, None] > 0)
            from_pool = a[:, None] * share[u]
            own_part = np.where(by_seed, a * (1 - share[u].sum(axis=1)), 0.0)
            carried = from_pool.copy()
            carried[by_seed, own[u[by_seed]]] += own_part[by_seed]
            update = np.zeros((n, s))
            np.add.at(update, v, carried)
            converged = np.abs(update - incoming).max(initial=0.0) < 1e-6
            incoming = update
            if converged:
                break
        require(converged, f"Деньги seed: расчёт за {pd.Timestamp(day).date()} не сошёлся")
        leaving = np.zeros((n, s))
        np.add.at(leaving, u, from_pool)
        pool_seed = np.maximum(pool_seed + incoming - leaving, 0.0)
        pool = funded - out_today
        received += incoming
        np.add.at(sent, u, carried)
        origin += np.bincount(u, own_part, n)
        unobserved += np.where(own < 0, out_today - available, 0.0).clip(min=0.0)
        tx_seed[rows] = carried.sum(axis=1)
    kept = received.sum(axis=1) - (sent.sum(axis=1) - origin)
    return {"received": received, "sent": sent, "origin": origin, "kept": np.maximum(kept, 0.0),
            "unobserved": unobserved, "tx": tx.assign(seed_kzt=tx_seed)}


# ---------------------------------------------------------------- признаки узлов

def match_fast(incoming, outgoing):
    """FIFO: сколько входа можно сопоставить с выходом в тот же день или через 1–2 дня.

    Один KZT не используется дважды. Это совместимость дат и сумм, не трассировка денег.
    """
    pending = deque()
    matched = 0.0
    for day in sorted(set(incoming) | set(outgoing)):
        while pending and (day - pending[0][0]).days > FAST_DAYS:
            pending.popleft()
        if incoming.get(day, 0.0) > 0:
            pending.append([day, incoming[day]])
        available = outgoing.get(day, 0.0)
        while pending and available > 0:
            amount = min(available, pending[0][1])
            matched += amount
            available -= amount
            pending[0][1] -= amount
            if pending[0][1] <= 0:
                pending.popleft()
    return matched


def count_by_gid(df, counts):
    return df.gid.map(counts).fillna(0).astype("int64")


def basic_features(graph, nodes, edges, tx):
    df = nodes[["gid", "depth", "is_seed"]].sort_values("gid").reset_index(drop=True)
    for prefix, degree in (("in", graph.in_degree), ("out", graph.out_degree)):
        for suffix, weight in (("deg", None), ("kzt", "sum_kzt"), ("tx", "n_tx")):
            df[f"{prefix}_{suffix}"] = df.gid.map(dict(degree(weight=weight))).astype(
                float if suffix == "kzt" else "int64")
    in_kzt = df.in_kzt.replace(0, np.nan)
    # У seed неполон вход, на границе неизвестен выход; отношение не интерпретируется.
    df["pass_through"] = (df.out_kzt / in_kzt).where(~df.is_seed & df.depth.lt(4))
    df["truncated_by_depth"] = df.depth.eq(4) & df.out_deg.eq(0)
    seeds = set(df.gid[df.is_seed])
    df["seed_in_deg"] = df.gid.map({gid: sum(p in seeds for p in graph.predecessors(gid))
                                    for gid in graph}).astype("int64")

    # Время: дни, сквозной транзит, ранний вход, синхронный сбор, дробление.
    daily = {}
    for side, key in (("in", "dst"), ("out", "src")):
        series = tx.groupby([key, "date"], sort=True).sum_kzt.sum()
        daily[side] = {gid: group.droplevel(0).to_dict() for gid, group in series.groupby(level=0)}
        df[f"{side}_days"] = count_by_gid(df, {gid: len(days) for gid, days in daily[side].items()})
    fast, early = {}, {}
    for gid in df.gid:
        incoming, outgoing = daily["in"].get(gid, {}), daily["out"].get(gid, {})
        fast[gid] = match_fast(incoming, outgoing)
        early[gid] = sum(amount for day, amount in incoming.items() if day <= EARLY_END)
    df["fast_kzt"] = df.gid.map(fast).astype(float)
    df["fast_share"] = (df.fast_kzt / in_kzt).fillna(0).clip(0, 1)
    df["early_in_share"] = (df.gid.map(early) / in_kzt).fillna(0).clip(0, 1)
    payers = tx.groupby(["dst", "date"]).src.nunique()
    df["max_payers_day"] = count_by_gid(df, payers.groupby(level=0).max())
    df["sync_days"] = count_by_gid(df, payers[payers >= SYNC_PAYERS].groupby(level=0).size())
    same_day = tx.groupby(["src", "dst", "date"]).size()
    df["split_days"] = count_by_gid(df, same_day[same_day >= SPLIT_TX].groupby(level=0).size())

    # Маршруты: возврат денег за 2–3 шага и повторяющиеся цепочки A→узел→C.
    cycles = Counter(gid for cycle in nx.simple_cycles(graph, length_bound=3) for gid in cycle)
    df["return_flows"] = count_by_gid(df, cycles)
    arrivals = {gid: list(zip(group.src, group.date)) for gid, group in tx.groupby("dst")}
    relays = Counter()
    for r in tx.itertuples(index=False):
        for payer in {a for a, day in arrivals.get(r.src, ()) if a != r.dst
                      and 0 <= (r.date - day).days <= FAST_DAYS}:
            relays[(payer, r.src, r.dst)] += 1
    df["stable_routes"] = count_by_gid(df, Counter(mid for (_, mid, _), n in relays.items() if n >= 2))

    # Деньги seed.
    money = seed_money(tx, nodes)
    position = pd.Series(np.arange(len(nodes)), index=nodes.gid)[df.gid].to_numpy()
    received, sent = money["received"][position], money["sent"][position]
    df["seed_in_kzt"] = received.sum(axis=1)
    df["seed_out_kzt"] = sent.sum(axis=1)
    df["seed_origin_kzt"] = money["origin"][position]
    df["seed_kept_kzt"] = money["kept"][position]
    df["seed_sources"] = (received >= MIN_TX_KZT).sum(axis=1).astype("int64")
    df["seed_share_in"] = (df.seed_in_kzt / in_kzt).fillna(0).clip(0, 1)
    forwarded = df.seed_out_kzt - df.seed_origin_kzt
    df["seed_forwarded_share"] = (forwarded / df.seed_in_kzt.replace(0, np.nan)).fillna(0).clip(0, 1)
    df["external_share"] = (money["unobserved"][position] / df.out_kzt.replace(0, np.nan)).where(
        ~df.is_seed).clip(0, 1)

    # 4-е колено: сравнение с похожими узлами 1–3 колена, у которых выход известен.
    senders = edges.groupby("src").size()
    from_fan = edges.sum_kzt.where(edges.src.map(senders).ge(FAN_OUT), 0.0)
    fan_share = from_fan.groupby(edges.dst).sum() / edges.groupby("dst").sum_kzt.sum()
    df["from_fan_share"] = df.gid.map(fan_share).fillna(0.0)
    days = pd.Series(np.select([df.in_days.ge(3), df.in_days.eq(2)], ["3+ дней", "2 дня"], "1 день"),
                     index=df.index)
    df["similar_segment"] = days + np.where(df.from_fan_share.ge(0.5), ", от «веера»", ", не от «веера»")
    known = df.depth.between(1, 3) & ~df.is_seed & df.in_kzt.gt(0)
    kept = df.out_kzt.le(0.1 * df.in_kzt)
    stats = kept[known].groupby(df.similar_segment[known]).agg(["size", "mean"])
    df["similar_n"] = df.similar_segment.map(stats["size"]).fillna(0).astype("int64")
    df["similar_p_terminal"] = df.similar_segment.map(stats["mean"]).fillna(0.0)
    return df, money["tx"]


def boundary_backtest(df):
    """Проверка метода 4-го колена: доли по 1–2 колену применяем к 3-му, где выход известен."""
    known = df[df.depth.between(1, 3) & ~df.is_seed & df.in_kzt.gt(0)]
    kept = known.out_kzt.le(0.1 * known.in_kzt)
    train, test = known.depth.le(2), known.depth.eq(3)
    rates = kept[train].groupby(known.similar_segment[train]).agg(["size", "mean"])
    segment = known.similar_segment[test]
    chosen = segment.map(rates["mean"]).ge(BOUNDARY_TERMINAL) & segment.map(rates["size"]).ge(BOUNDARY_MIN_SIMILAR)
    return {"test_nodes": int(test.sum()), "base_rate": float(kept[test].mean()),
            "chosen": int(chosen.sum()), "precision": float(kept[test][chosen].mean()) if chosen.any() else 0.0}


# ---------------------------------------------------------------- роли

def c(x):
    return min(max(x, 0.0), 1.0)


def role_scores(r):
    """Поддержка каждой гипотезы: 0 — минимальный признак роли не выполнен.

    Score — эвристическая сила признаков, а не вероятность. Формулы — в README.
    """
    scores = dict.fromkeys(ROLES[:-1], 0.0)
    if r.in_deg + r.out_deg == 0:
        return scores
    boundary = r.depth == 4
    if r.in_deg >= 3 and r.out_deg <= r.in_deg / 2:
        scores["consolidator"] = (0.35 + 0.20 * c((r.in_deg - 3) / 7) + 0.10 * c(r.in_tx / 20)
                                  + 0.10 * (r.max_payers_day >= SYNC_PAYERS)
                                  + 0.15 * c((r.seed_sources - 1) / 2))
    if not boundary and r.out_deg >= 5:
        scores["distributor"] = (0.30 + 0.25 * c((r.out_deg - 5) / 45) + 0.10 * c(r.out_tx / 50)
                                 + 0.10 * (r.out_kzt >= 1_000_000))
    if not boundary and r.in_deg >= 2 and r.out_deg >= 3 and r.seed_sources >= 2:
        scores["coordinator"] = (0.55 + 0.15 * c((r.seed_sources - 2) / 3) + 0.10 * c(r.in_deg / 10)
                                 + 0.10 * c(r.out_deg / 20))
    if not boundary and not r.is_seed and r.in_kzt > 0:
        ratio = r.pass_through
        if 0.8 <= ratio <= 1.2:
            scores["transit"] = (0.35 + 0.25 * r.fast_share + 0.10 * c(1 - abs(ratio - 1) / 0.2)
                                 + 0.10 * (r.in_tx >= 2 and r.out_tx >= 2)
                                 + 0.10 * (min(r.in_kzt, r.out_kzt) >= MATERIAL_KZT))
        if ratio <= 0.1 and (r.in_kzt >= MATERIAL_KZT or r.in_tx >= 3):
            scores["terminal"] = (0.30 + 0.20 * c((r.in_tx - 1) / 4) + 0.15 * r.early_in_share
                                  + 0.10 * (r.in_kzt >= MATERIAL_KZT))
    if boundary:
        if r.similar_p_terminal >= BOUNDARY_TERMINAL and r.similar_n >= BOUNDARY_MIN_SIMILAR:
            scores["terminal"] = 0.20 + 0.15 * c((r.similar_p_terminal - BOUNDARY_TERMINAL)
                                                 / (1 - BOUNDARY_TERMINAL))
        scores = {role: min(score, BOUNDARY_CAP) for role, score in scores.items()}
    return {role: round(score, 6) for role, score in scores.items()}


def peripheral_score(r):
    """Уверенность в том, что роли нет: ниже там, где наблюдение неполное."""
    if r.in_deg + r.out_deg == 0:
        return 0.10
    if r.depth == 4:
        return 0.20
    return 0.30 if r.is_seed else 0.50


def choose_role(r):
    """Правила проверяются в порядке ROLES, первое выполненное — основная роль.

    Следующее выполненное правило — secondary_role. Score — сила признаков основной роли.
    """
    scores = role_scores(r)
    matched = [role for role in ROLES[:-1] if scores[role] > 0]
    if not matched:
        return "peripheral", peripheral_score(r), ""
    return matched[0], scores[matched[0]], matched[1] if len(matched) > 1 else ""


def node_patterns(r):
    checks = {
        "seed": r.is_seed,
        "isolated": r.in_deg + r.out_deg == 0,
        "boundary": r.depth == 4,
        "external_funding": r.external_share >= 0.5 and r.out_kzt >= MATERIAL_KZT,
        "fast_transit": r.fast_share >= 0.5,
        "sync_inflow": r.sync_days > 0,
        "split": r.split_days > 0,
        "return_flow": r.return_flows > 0,
        "stable_route": r.stable_routes > 0,
        "late_inflow": r.depth < 4 and r.in_kzt > 0 and r.early_in_share < 0.8,
    }
    return ";".join(pattern for pattern in PATTERNS if checks[pattern])


def data_gap(r):
    """Какой запрос закрывает главное белое пятно по узлу."""
    if r.in_deg + r.out_deg == 0:
        return "нет переводов: запросить выписку за другой период и каналы"
    if r.depth == 4:
        return "граница обхода: запросить исходящие переводы"
    if r.is_seed and r.out_deg == 0:
        return "seed без исходящих: запросить выписку"
    if r.external_share >= 0.5 and r.out_kzt >= MATERIAL_KZT:
        return "выход не покрыт входом: запросить входящие извне выборки"
    if r.role == "terminal" and r.early_in_share < 0.8:
        return "поздние поступления: запросить переводы за август"
    if r.seed_kept_kzt >= MATERIAL_KZT:
        return "деньги seed остались на счёте: проверить остаток, межбанк и наличные"
    return ""


# ---------------------------------------------------------------- тексты

def money(x):
    """Сумма для чтения: 1 234 567 → «1,2 млн ₸». Точные значения — в числовых колонках."""
    if round(x / 1e5) >= 10:
        return f"{x / 1e6:.1f} млн ₸".replace(".", ",")
    if round(x) >= 1000:
        return f"{x / 1e3:.0f} тыс. ₸"
    return f"{x:.0f} ₸"


def pct(x):
    return f"{x:.0%}"


def plural(n, one, few, many):
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} {one}"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} {few}"
    return f"{n} {many}"


def payers(n):
    return plural(n, "плательщик", "плательщика", "плательщиков")


def from_payers(n):
    return plural(n, "плательщика", "плательщиков", "плательщиков")


def receivers(n):
    return plural(n, "получатель", "получателя", "получателей")


def transfers(n):
    return plural(n, "перевод", "перевода", "переводов")


def seed_phrase(r):
    if r.seed_in_kzt < MIN_TX_KZT:
        return "денег seed не видно"
    return f"денег seed ≈{money(r.seed_in_kzt)} от {r.seed_sources} seed"


def evidence(r):
    """Человекочитаемое обоснование до 200 символов: правило роли и его числа."""
    if r.in_deg + r.out_deg == 0:
        text = "Нет переводов в выгрузке: 0 входящих и 0 исходящих — роль неизвестна."
    elif r.depth == 4:
        head = "4-е колено, выход не виден."
        if r.role == "consolidator":
            text = f"{head} Сбор: {payers(r.in_deg)}, {transfers(r.in_tx)}, {money(r.in_kzt)}."
        elif r.role == "terminal":
            text = (f"{head} Из {r.similar_n} похожих узлов 1–3 колена {pct(r.similar_p_terminal)} "
                    f"не отдали деньги дальше. Получил {money(r.in_kzt)}.")
        else:
            text = (f"{head} Из {r.similar_n} похожих узлов деньги оставили {pct(r.similar_p_terminal)} — "
                    f"мало для вывода. Получил {money(r.in_kzt)}.")
    elif r.role == "coordinator":
        others = "других " if r.is_seed else ""
        text = (f"Координация: деньги {r.seed_sources} {others}seed (≈{money(r.seed_in_kzt)}); "
                f"{payers(r.in_deg)} → {receivers(r.out_deg)}; дальше ушло {pct(r.seed_forwarded_share)} денег seed.")
    elif r.role == "consolidator":
        ratio = f" отдал {pct(r.pass_through)};" if pd.notna(r.pass_through) else ""
        text = (f"Сбор: {payers(r.in_deg)}, {transfers(r.in_tx)}, {money(r.in_kzt)} → "
                f"{receivers(r.out_deg)};{ratio} {seed_phrase(r)}.")
    elif r.role == "distributor":
        gap = (f" {pct(r.external_share)} выхода — не из наблюдаемой сети;"
               if r.external_share >= 0.5 else "")
        text = (f"Веер: {receivers(r.out_deg)}, {transfers(r.out_tx)}, {money(r.out_kzt)}; "
                f"из сети получил {money(r.in_kzt)};{gap} {seed_phrase(r)}.")
    elif r.role == "transit":
        text = (f"Транзит: получил {money(r.in_kzt)}, отдал {pct(r.pass_through)}; "
                f"за 0–2 дня ушло {pct(r.fast_share)}; {seed_phrase(r)}.")
    elif r.role == "terminal":
        text = (f"Конечный получатель: получил {money(r.in_kzt)} от {from_payers(r.in_deg)}, "
                f"отдал {pct(r.pass_through)}; до 24.07 пришло {pct(r.early_in_share)}; {seed_phrase(r)}.")
    else:
        ratio = f" ({pct(r.pass_through)})" if pd.notna(r.pass_through) else ""
        seed = f" {seed_phrase(r)};" if r.seed_in_kzt >= MIN_TX_KZT else ""
        text = (f"Периферия: получил {money(r.in_kzt)} ({transfers(r.in_tx)}), отдал {money(r.out_kzt)}"
                f"{ratio} {plural(r.out_deg, 'получателю', 'получателям', 'получателям')};{seed} "
                "признаков ролей не выявлено.")
    return f"{text} Seed: вход неполон." if r.is_seed else text


def number(x):
    return f"{x:.2f}".replace(".", ",")


def why(r):
    also = f" Также признаки: {ROLE_RU[r.secondary_role]}." if r.secondary_role else ""
    known = " Уже в списке seed." if r.is_seed else ""
    w = PRIORITY_WEIGHTS
    return (f"{r.evidence}{also} Приоритет {number(r.priority_score)} = "
            f"{number(w['money'])}×{number(r.money_score)} (деньги seed) + "
            f"{number(w['sources'])}×{number(r.sources_score)} (разные seed) + "
            f"{number(w['role'])}×{number(r.role_part)} (роль).{known} Гипотеза для проверки.")


# ---------------------------------------------------------------- приоритет и выгрузки

def score_nodes(df, cluster_map):
    df = df.copy()
    choices = [choose_role(r) for r in df.itertuples(index=False)]
    df["role"] = [role for role, _, _ in choices]
    df["role_score"] = [score for _, score, _ in choices]
    df["secondary_role"] = [second for _, _, second in choices]
    df["cluster_id"] = df.gid.map(cluster_map).astype("int64")
    # Фиксированные шкалы, не min/max выборки. 5 тыс. ₸ → 0, 50 тыс. → 1/3, 500 тыс. → 2/3, 5 млн → 1.
    df["money_score"] = (np.log10(df.seed_in_kzt.clip(lower=MIN_TX_KZT) / MIN_TX_KZT) / 3).clip(0, 1)
    df["sources_score"] = ((df.seed_sources - 1) / 3).clip(0, 1)
    df["role_weight"] = df.role.map(ROLE_WEIGHTS)
    df["role_part"] = df.role_weight * df.role_score
    w = PRIORITY_WEIGHTS
    df["priority_score"] = (w["money"] * df.money_score + w["sources"] * df.sources_score
                            + w["role"] * df.role_part).round(9)
    df["patterns"] = [node_patterns(r) for r in df.itertuples(index=False)]
    df["data_gap"] = [data_gap(r) for r in df.itertuples(index=False)]
    df["evidence"] = [evidence(r) for r in df.itertuples(index=False)]
    front = NODE_COLUMNS + ["secondary_role", "patterns", "data_gap"]
    return df[front + [col for col in df if col not in front]].reset_index(drop=True)


def ranked(df):
    return df.sort_values(["priority_score", "gid"], ascending=[False, True])


def cluster_hypothesis(group, stability):
    if (group.in_tx + group.out_tx).sum() == 0:
        return "Нет переводов в выгрузке; назначение неизвестно."
    kept = group.seed_kept_kzt.sum()
    seed_text = f"денег seed ≈{money(kept)}" if kept >= MIN_TX_KZT else "денег seed не видно"
    outflow = group.out_kzt.sum()
    external = (group.external_share.fillna(0) * group.out_kzt).sum()
    # Рассыльщик — узел-веер, отправивший больше всего денег seed, а не просто больше всех получателей.
    fans = group[group.out_deg.ge(FAN_OUT) & group.seed_out_kzt.ge(MATERIAL_KZT)]
    if kept >= MATERIAL_KZT:
        keeper = group.loc[group.seed_kept_kzt.idxmax()]
        share = keeper.seed_kept_kzt / kept
        holders = int(group.seed_kept_kzt.ge(MIN_TX_KZT).sum())
        if share >= 0.3:
            text = (f"Гипотеза: сбор денег seed в {keeper.gid} ({ROLE_RU[keeper.role]}): "
                    f"{pct(share)} из ≈{money(kept)}, осевших в кластере.")
        elif len(fans):
            hub = fans.sort_values(["seed_out_kzt", "gid"]).iloc[-1]
            text = (f"Гипотеза: веерная рассылка денег seed: {hub.gid} отправил ≈{money(hub.seed_out_kzt)} "
                    f"{plural(hub.out_deg, 'получателю', 'получателям', 'получателям')}; "
                    f"осело у {holders} участников, у крупнейшего — {pct(share)}.")
        else:
            text = (f"Гипотеза: деньги seed рассредоточены: ≈{money(kept)} у {holders} участников, "
                    f"у крупнейшего — {pct(share)}.")
    elif outflow > 0 and external / outflow >= 0.5:
        payer = group.loc[group.out_kzt.idxmax()]
        text = (f"Гипотеза: окружение крупного плательщика {payer.gid}: {pct(external / outflow)} "
                f"выхода участников — не из наблюдаемой сети; {seed_text}.")
    elif group.role.eq("distributor").any():
        hub = group[group.role.eq("distributor")].sort_values(["out_deg", "gid"]).iloc[-1]
        text = f"Гипотеза: веерная рассылка от {hub.gid} на {receivers(hub.out_deg)}; {seed_text}."
    else:
        text = f"Слабые признаки роли; {seed_text}."
    counts = group.role.value_counts()
    profile = ", ".join(f"{ROLE_RU[role]} {counts[role]}" for role in ROLES[:-1] if counts.get(role, 0))
    return (f"{text} Seed: {int(group.is_seed.sum())}; роли: {profile or 'нет'}; "
            f"устойчивость {number(stability)}. Не доказательство общей деятельности.")


def cluster_outputs(df, edges, stability):
    membership = df.set_index("gid").cluster_id
    flows = edges.assign(src_cluster=edges.src.map(membership), dst_cluster=edges.dst.map(membership))
    internal = flows[flows.src_cluster.eq(flows.dst_cluster)].groupby("src_cluster").sum_kzt.sum()
    rows = []
    for cluster_id, group in df.groupby("cluster_id", sort=True):
        lead = ranked(group).iloc[0]
        rows.append((cluster_id, len(group), int(group.is_seed.sum()), float(internal.get(cluster_id, 0.0)),
                     ";".join(str(gid) for gid in ranked(group).gid.head(5)),
                     cluster_hypothesis(group, stability[cluster_id]), round(stability[cluster_id], 6),
                     float(group.seed_origin_kzt.sum()), float(group.seed_kept_kzt.sum()),
                     int(lead.gid), lead.role))
    return pd.DataFrame(rows, columns=CLUSTER_COLUMNS + ["stability", "seed_kzt_origin", "seed_kzt_kept",
                                                         "lead_gid", "lead_role"])


def top_outputs(df, top_n):
    top = ranked(df).head(top_n).copy()
    top["why"] = [why(r) for r in top.itertuples(index=False)]
    top["rank"] = np.arange(1, len(top) + 1, dtype="int64")
    extra = ["secondary_role", "is_seed", "depth", "cluster_id", "seed_in_kzt", "seed_sources",
             "money_score", "sources_score", "role_part", "patterns"]
    return top[TOP_COLUMNS + extra].reset_index(drop=True)


def blocking(order, graph, tx, nodes, scenario=""):
    """Что будет с сетью, если заблокировать первые N из order (их исходящие переводы не происходят).

    seed_kzt_to_others_share — доля всех денег seed, осевшая у остальных не-seed клиентов;
    seed_kzt_held_share — доля, которая без блокировки осела бы у самих заблокированных.
    Знаменатель одинаков для всех N, поэтому строки можно сравнивать.
    """
    base = seed_money(tx, nodes)
    total = base["origin"].sum()
    rows = []
    for k in (0,) + RESILIENCE_TOP:
        removed = set(order[:k])
        blocked = nodes.gid.isin(removed).to_numpy()
        others = ~nodes.is_seed.to_numpy() & ~blocked
        after = seed_money(tx, nodes, blocked=removed) if k else base
        rest = graph.copy()
        rest.remove_nodes_from(removed)
        components = [len(c) for c in nx.weakly_connected_components(rest)]
        rows.append((scenario, k, ";".join(str(gid) for gid in order[:k]), max(components), len(components),
                     after["kept"][others].sum() / total, base["kept"][blocked].sum() / total))
    return pd.DataFrame(rows, columns=["scenario", "removed_top_n", "removed_gids", "largest_component",
                                       "n_components", "seed_kzt_to_others_share", "seed_kzt_held_share"])


def resilience(df, graph, tx, nodes):
    """Два сценария: весь топ и только новые счета топа (seed аналитику уже известны)."""
    order = ranked(df)
    return pd.concat([blocking(order.gid.tolist(), graph, tx, nodes, "top"),
                      blocking(order.gid[~order.is_seed].tolist(), graph, tx, nodes, "top_new")],
                     ignore_index=True)


def data_requests(df):
    """Очередь запросов недостающих данных: узлы с белым пятном в порядке приоритета."""
    rows = ranked(df[df.data_gap.ne("") & (df.seed_in_kzt.ge(MIN_TX_KZT) | df.is_seed)])
    return rows[["gid", "data_gap", "priority_score", "role", "seed_in_kzt", "seed_kept_kzt", "depth",
                 "is_seed"]].rename(columns={"data_gap": "request"}).reset_index(drop=True)


def edge_flows(edges, tx_seed):
    seed_kzt = tx_seed.groupby(["src", "dst"]).seed_kzt.sum()
    flows = edges.merge(seed_kzt.rename("seed_kzt").reset_index(), on=["src", "dst"], how="left")
    flows["seed_kzt"] = flows.seed_kzt.fillna(0.0)
    flows["seed_share"] = (flows.seed_kzt / flows.sum_kzt).clip(0, 1)
    return flows[["src", "dst", "sum_kzt", "n_tx", "seed_kzt", "seed_share"]]


# ---------------------------------------------------------------- проверки выгрузок

def validate_outputs(df, clusters, top, nodes, edges, top_n):
    """Проверяет именно прочитанные CSV, включая независимую сверку агрегатов."""
    require(list(df.columns[:6]) == NODE_COLUMNS, "Неверная схема nodes_roles")
    require(list(clusters.columns[:6]) == CLUSTER_COLUMNS, "Неверная схема clusters")
    require(list(top.columns[:5]) == TOP_COLUMNS, "Неверная схема top_nodes")
    for frame, columns in ((df, NODE_COLUMNS), (clusters, CLUSTER_COLUMNS), (top, TOP_COLUMNS)):
        require(not frame[columns].isna().any().any(), "Пустое обязательное поле")
    for frame, columns in ((df, ["gid", "cluster_id"]),
                           (clusters, ["cluster_id", "n_nodes", "n_seed"]), (top, ["rank", "gid"])):
        require(all(is_integer_dtype(frame[col]) for col in columns), "Целые поля потеряли тип")
    require(df.gid.is_unique and len(df) == len(nodes) and set(df.gid) == set(nodes.gid),
            "Потерянные, лишние или повторные gid")
    source_nodes = nodes.set_index("gid").loc[df.gid]
    require(np.array_equal(df.depth, source_nodes.depth)
            and np.array_equal(df.is_seed, source_nodes.is_seed), "Метаданные узлов изменились")
    for side, key in (("in", "dst"), ("out", "src")):
        observed = edges.groupby(key).agg(deg=("sum_kzt", "size"), kzt=("sum_kzt", "sum"), tx=("n_tx", "sum"))
        observed = observed.reindex(df.gid, fill_value=0)
        for metric in ("deg", "kzt", "tx"):
            require(np.allclose(df[f"{side}_{metric}"], observed[metric], rtol=0,
                                atol=0.01 if metric == "kzt" else 0), f"Неверный {side}_{metric}")
    require(set(df.role) <= set(ROLES), "Недопустимая роль")
    second = df.secondary_role.fillna("")
    require(second.isin(("",) + ROLES[:-1]).all() and second.ne(df.role).all(), "Неверная secondary_role")
    for col in ("role_score", "priority_score", "money_score", "sources_score", "role_part"):
        require(np.isfinite(df[col]).all() and df[col].between(0, 1).all(), f"Неверный {col}")
    require(df.evidence.str.len().between(1, 200).all() and df.evidence.str.contains(r"\d").all(),
            "evidence должен содержать числа и не более 200 символов")
    boundary = df[df.depth.eq(4)]
    require(boundary.role.isin(["consolidator", "terminal", "peripheral"]).all()
            and boundary.role_score.le(BOUNDARY_CAP).all(), "Роль или уверенность на границе обхода")
    require(not df.loc[df.is_seed, "role"].isin(["terminal", "transit"]).any(), "Балансовая роль у seed")
    require(df.loc[df.is_seed | df.depth.eq(4) | df.in_kzt.eq(0), "pass_through"].isna().all(),
            "Отношение out/in при неполном наблюдении")
    tol = 0.01
    require(df.seed_in_kzt.ge(-tol).all() and (df.seed_in_kzt <= df.in_kzt + tol).all()
            and (df.seed_out_kzt <= df.out_kzt + tol).all() and df.seed_kept_kzt.ge(-tol).all(),
            "Деньги seed вне наблюдаемых сумм")
    require(df.loc[~df.is_seed, "seed_origin_kzt"].abs().le(tol).all(), "Деньги seed возникли не у seed")
    require(abs(df.seed_origin_kzt.sum() - df.seed_kept_kzt.sum()) <= 1.0, "Деньги seed не сохраняются")
    require(clusters.cluster_id.is_unique and set(df.cluster_id) == set(clusters.cluster_id), "Кластеры не согласованы")
    require(clusters.stability.between(0, 1).all(), "Неверная устойчивость кластера")
    actual = df.groupby("cluster_id").agg(n_nodes=("gid", "size"), n_seed=("is_seed", "sum"))
    expected = clusters.set_index("cluster_id").sort_index()
    require(actual.n_nodes.equals(expected.n_nodes) and actual.n_seed.equals(expected.n_seed), "Размеры кластеров/seed")
    mapping = df.set_index("gid").cluster_id
    source, target = edges.src.map(mapping), edges.dst.map(mapping)
    amounts = edges.loc[source.eq(target)].groupby(source[source.eq(target)]).sum_kzt.sum()
    require(np.allclose(expected.sum_kzt_internal, amounts.reindex(expected.index, fill_value=0), rtol=0, atol=0.01),
            "Неверный внутренний оборот")
    for r in clusters.itertuples(index=False):
        members = ranked(df[df.cluster_id.eq(r.cluster_id)]).gid.head(5).tolist()
        require([int(gid) for gid in str(r.top_gids).split(";")] == members, "Неверные top_gids")
        require(bool(r.hypothesis.strip()), "Пустая гипотеза кластера")
    require(len(top) == min(top_n, len(nodes)) and len(top) >= min(20, len(nodes)), "Размер top_nodes")
    require(top.gid.is_unique and top['rank'].tolist() == list(range(1, len(top) + 1)), "Неверные ранги")
    order = ranked(df).head(top_n)
    require(top.gid.tolist() == order.gid.tolist(), "Неверная сортировка top_nodes")
    require(top.role.tolist() == order.role.tolist() and np.allclose(top.priority_score, order.priority_score, rtol=0, atol=1e-9),
            "top_nodes не согласован с nodes_roles")
    require(top.why.str.strip().str.len().gt(0).all() and top.why.str.contains(r"\d").all(), "Пустое объяснение top_nodes")
    w = PRIORITY_WEIGHTS
    recomputed = w["money"] * df.money_score + w["sources"] * df.sources_score + w["role"] * df.role_weight * df.role_score
    require(np.allclose(df.priority_score, recomputed, rtol=0, atol=2e-9), "Формула приоритета не сходится")


def write_outputs(df, clusters, top, extra, out_dir, nodes, edges, top_n):
    validate_outputs(df, clusters, top, nodes, edges, top_n)
    out_dir.mkdir(parents=True, exist_ok=True)
    tables = {"nodes_roles.csv": df, "clusters.csv": clusters, "top_nodes.csv": top, **extra}
    for name, frame in tables.items():
        frame.to_csv(out_dir / name, index=False, encoding="utf-8", float_format="%.9f", lineterminator="\n")
    reread = [pd.read_csv(out_dir / name, dtype={"top_gids": str})
              for name in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv")]
    validate_outputs(*reread, nodes, edges, top_n)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=SCRIPT_DIR.parent / "docs" / "data")
    ap.add_argument("--out", type=Path, default=SCRIPT_DIR / "out")
    ap.add_argument("--top", type=int, default=30, help="Размер топ-листа, минимум 20")
    args = ap.parse_args()
    if args.top < 20:
        ap.error("--top должен быть не меньше 20")
    # docs — неизменяемый источник, в том числе при явном --out.
    docs = (SCRIPT_DIR.parent / "docs").resolve()
    require(docs not in (args.out.resolve(), *args.out.resolve().parents), "Нельзя писать выгрузки в docs/")
    edges, nodes, tx = load(args.data)
    sanity_check(edges, nodes, tx)
    graph = build_graph(edges, nodes)
    cluster_map, stability = assign_clusters(graph)
    features, tx_seed = basic_features(graph, nodes, edges, tx)
    df = score_nodes(features, cluster_map)
    clusters, top = cluster_outputs(df, edges, stability), top_outputs(df, args.top)
    extra = {"resilience.csv": resilience(df, graph, tx, nodes), "data_requests.csv": data_requests(df),
             "edges_flow.csv": edge_flows(edges, tx_seed)}
    write_outputs(df, clusters, top, extra, args.out, nodes, edges, args.top)

    origin = df.seed_origin_kzt.sum()
    by_depth = df.groupby("depth").seed_kept_kzt.sum() / origin
    backtest = boundary_backtest(df)
    cut = extra["resilience.csv"].query("scenario == 'top_new'").set_index("removed_top_n")
    print(f"Вход: узлы={len(nodes)}, рёбра={len(edges)}, транзакции={len(tx)}, seed={int(nodes.is_seed.sum())}")
    print(f"Деньги seed: выпущено {money(origin)}; осело по коленам: "
          + ", ".join(f"{depth}: {pct(share)}" for depth, share in by_depth.items()))
    print(f"Роли: {df.role.value_counts().to_dict()}")
    print(f"Топ-{len(top)}: денег seed {money(top.seed_in_kzt.sum())}; seed в топе: {int(top.is_seed.sum())}")
    print(f"4-е колено: проверка на 3-м колене — выбрано {backtest['chosen']} из {backtest['test_nodes']}, "
          f"конечных среди выбранных {pct(backtest['precision'])} при базовой доле {pct(backtest['base_rate'])}")
    print("Блокировка N новых счетов из топа: денег seed у остальных / у заблокированных — "
          + ", ".join(f"N={k}: {pct(cut.loc[k, 'seed_kzt_to_others_share'])} / {pct(cut.loc[k, 'seed_kzt_held_share'])}"
                      for k in RESILIENCE_TOP))
    print(f"CSV проверены после чтения: узлы={len(df)}, кластеры={len(clusters)}, top={len(top)}")
    print(f"Результат: {args.out.resolve()}")
    elapsed = perf_counter() - STARTED
    print(f"Полный расчёт с импортами и проверкой CSV: {elapsed:.3f} с (лимит 300 с)")
    require(elapsed < 300, "Превышен лимит расчёта 5 минут")


if __name__ == "__main__":
    main()
