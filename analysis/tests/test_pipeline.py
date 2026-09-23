"""Проверки правил, денег seed и контракта приложенного датасета."""

import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pipeline", ROOT / "analysis" / "run.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)
NAN = float("nan")


def features(**changes):
    """Узел 2-го колена: 3 плательщика → 1 получатель, отдал 5% — базовый «сбор»."""
    values = dict(depth=2, is_seed=False, in_deg=3, out_deg=1, in_kzt=200_000, out_kzt=10_000,
                  in_tx=6, out_tx=1, pass_through=0.05, fast_share=0.0, early_in_share=1.0,
                  max_payers_day=1, seed_sources=1, similar_p_terminal=0.0, similar_n=0)
    values.update(changes)
    return SimpleNamespace(**values)


def boundary(**changes):
    return features(**{**dict(depth=4, in_deg=1, out_deg=0, out_kzt=0, out_tx=0, pass_through=NAN), **changes})


class RulesTest(unittest.TestCase):
    def test_boundary_allows_only_inflow_roles_with_capped_support(self):
        role, score, _ = pipeline.choose_role(boundary(similar_p_terminal=0.81, similar_n=839))
        self.assertEqual(role, "terminal")
        self.assertLessEqual(score, pipeline.BOUNDARY_CAP)
        self.assertEqual(pipeline.choose_role(boundary(similar_p_terminal=0.81, similar_n=50))[0], "peripheral")
        self.assertEqual(pipeline.choose_role(boundary(similar_p_terminal=0.60, similar_n=839)),
                         ("peripheral", 0.20, ""))
        role, score, _ = pipeline.choose_role(boundary(in_deg=3, in_tx=30, seed_sources=3))
        self.assertEqual(role, "consolidator")
        self.assertLessEqual(score, pipeline.BOUNDARY_CAP)

    def test_seed_never_gets_balance_role(self):
        for changes in [dict(in_deg=1, out_deg=0, out_kzt=0), dict(in_deg=1, out_kzt=200_000)]:
            role, _, second = pipeline.choose_role(features(is_seed=True, pass_through=NAN, **changes))
            self.assertNotIn(role, {"terminal", "transit"})
            self.assertNotIn(second, {"terminal", "transit"})

    def test_no_edges_means_unknown_even_for_seed(self):
        row = features(is_seed=True, in_deg=0, out_deg=0, in_kzt=0, out_kzt=0, pass_through=NAN)
        self.assertEqual(pipeline.choose_role(row), ("peripheral", 0.10, ""))

    def test_coordinator_needs_money_of_two_seeds(self):
        hub = features(in_deg=5, out_deg=10, out_tx=10, out_kzt=300_000, pass_through=1.5, seed_sources=2)
        self.assertEqual(pipeline.choose_role(hub)[::2], ("coordinator", "distributor"))
        hub.seed_sources = 1
        self.assertEqual(pipeline.choose_role(hub)[0], "distributor")

    def test_funnel_is_consolidator_with_transit_as_second_role(self):
        funnel = features(in_deg=5, out_deg=1, out_kzt=200_000, out_tx=2, pass_through=1.0)
        self.assertEqual(pipeline.choose_role(funnel)[::2], ("consolidator", "transit"))

    def test_weak_signal_keeps_role_with_low_support(self):
        pipe = features(in_deg=1, in_tx=1, in_kzt=20_000, out_kzt=20_000, pass_through=1.0)
        self.assertEqual(pipeline.choose_role(pipe)[:2], ("transit", 0.45))
        strong = features(in_deg=1, in_tx=3, out_tx=3, in_kzt=500_000, out_kzt=500_000,
                          pass_through=1.0, fast_share=1.0)
        self.assertEqual(pipeline.choose_role(strong)[:2], ("transit", 0.9))

    def test_transit_inclusive_thresholds(self):
        for ratio in (0.8, 1.2):
            row = features(in_deg=1, pass_through=ratio, out_kzt=200_000 * ratio)
            self.assertEqual(pipeline.choose_role(row)[0], "transit")
        for ratio in (0.799, 1.201):
            row = features(in_deg=1, pass_through=ratio, out_kzt=200_000 * ratio)
            self.assertEqual(pipeline.choose_role(row)[0], "peripheral")

    def test_terminal_requires_material_or_repeated_inflow(self):
        one = dict(in_deg=1, in_tx=1, out_deg=0, out_kzt=0, pass_through=0.0)
        self.assertEqual(pipeline.choose_role(features(in_kzt=20_000, **one))[0], "peripheral")
        self.assertEqual(pipeline.choose_role(features(in_kzt=100_000, **one))[0], "terminal")
        self.assertEqual(pipeline.choose_role(features(in_kzt=20_000, **{**one, "in_tx": 3}))[0], "terminal")
        late = pipeline.choose_role(features(in_kzt=100_000, **{**one, "early_in_share": 0.0}))[1]
        early = pipeline.choose_role(features(in_kzt=100_000, **one))[1]
        self.assertLess(late, early)

    def test_fast_matching_counts_same_day_without_reuse(self):
        d = pd.date_range("2026-07-01", periods=4).__getitem__
        self.assertEqual(pipeline.match_fast({d(0): 100}, {d(0): 100}), 100)
        self.assertEqual(pipeline.match_fast({d(0): 100}, {d(1): 80, d(2): 80}), 100)
        self.assertEqual(pipeline.match_fast({d(0): 100}, {d(3): 100}), 0)
        self.assertEqual(pipeline.match_fast({d(1): 100}, {d(0): 100}), 0)

    def test_texts_are_readable(self):
        self.assertEqual(pipeline.money(1_234_567), "1,2 млн ₸")
        self.assertEqual(pipeline.money(999_700), "1,0 млн ₸")
        self.assertEqual(pipeline.money(268_500), "268 тыс. ₸")
        self.assertEqual([pipeline.payers(n) for n in (1, 2, 5, 11, 22)],
                         ["1 плательщик", "2 плательщика", "5 плательщиков", "11 плательщиков", "22 плательщика"])
        self.assertEqual(pipeline.from_payers(2), "2 плательщиков")


class SeedMoneyTest(unittest.TestCase):
    """Маленькие графы: seed 1 и 2, клиенты 10, 11, 12."""

    NODES = pd.DataFrame({"gid": [1, 2, 10, 11, 12], "depth": [0, 0, 1, 2, 3],
                          "is_seed": [True, True, False, False, False]})

    def run_money(self, rows, blocked=()):
        tx = pd.DataFrame(rows, columns=["src", "dst", "date", "sum_kzt"])
        tx["date"] = pd.to_datetime(tx.date)
        result = pipeline.seed_money(tx, self.NODES, blocked)
        at = {gid: i for i, gid in enumerate(self.NODES.gid)}
        received = lambda gid: result["received"][at[gid]].sum()
        return result, at, received

    def test_chain_moves_money_and_keeps_it_at_the_end(self):
        result, at, received = self.run_money([(1, 10, "2026-07-01", 100_000), (10, 11, "2026-07-02", 100_000)])
        self.assertAlmostEqual(received(10), 100_000)
        self.assertAlmostEqual(received(11), 100_000)
        self.assertAlmostEqual(result["kept"][at[10]], 0)
        self.assertAlmostEqual(result["kept"][at[11]], 100_000)
        self.assertAlmostEqual(result["origin"].sum(), result["kept"].sum())

    def test_money_cannot_leave_before_it_arrives(self):
        result, at, received = self.run_money([(10, 11, "2026-07-01", 100_000), (1, 10, "2026-07-03", 100_000)])
        self.assertEqual(received(11), 0)
        self.assertAlmostEqual(result["unobserved"][at[10]], 100_000)

    def test_same_day_chain_is_allowed(self):
        _, _, received = self.run_money([(1, 10, "2026-07-05", 100_000), (10, 11, "2026-07-05", 100_000)])
        self.assertAlmostEqual(received(11), 100_000)

    def test_clean_money_dilutes_seed_share(self):
        _, _, received = self.run_money([(1, 10, "2026-07-01", 100_000), (12, 10, "2026-07-01", 100_000),
                                         (10, 11, "2026-07-02", 100_000)])
        self.assertAlmostEqual(received(11), 50_000)

    def test_unobserved_funding_never_creates_seed_money(self):
        result, at, received = self.run_money([(1, 10, "2026-07-01", 100_000), (10, 11, "2026-07-02", 300_000)])
        self.assertAlmostEqual(received(11), 100_000)
        self.assertAlmostEqual(result["unobserved"][at[10]], 200_000)

    def test_seed_keeps_attribution_of_money_from_other_seed(self):
        result, at, _ = self.run_money([(1, 2, "2026-07-01", 100_000), (2, 10, "2026-07-02", 150_000)])
        by_seed = result["received"][at[10]]
        self.assertAlmostEqual(by_seed[0], 100_000)
        self.assertAlmostEqual(by_seed[1], 50_000)
        self.assertAlmostEqual(result["origin"][at[2]], 50_000)

    def test_blocked_node_stops_the_flow(self):
        rows = [(1, 10, "2026-07-01", 100_000), (10, 11, "2026-07-02", 100_000)]
        _, _, received = self.run_money(rows, blocked={10})
        self.assertEqual(received(11), 0)


class DatasetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.edges, cls.nodes, cls.tx = pipeline.load(ROOT / "docs" / "data")
        pipeline.sanity_check(cls.edges, cls.nodes, cls.tx)
        cls.graph = pipeline.build_graph(cls.edges, cls.nodes)
        cls.cluster_map, cls.stability = pipeline.assign_clusters(cls.graph)
        features, _ = pipeline.basic_features(cls.graph, cls.nodes, cls.edges, cls.tx)
        cls.df = pipeline.score_nodes(features, cls.cluster_map)
        cls.clusters = pipeline.cluster_outputs(cls.df, cls.edges, cls.stability)
        cls.top = pipeline.top_outputs(cls.df, 30)

    def test_input_mismatch_is_rejected(self):
        for column, delta in [("sum_kzt", 1), ("n_tx", 1)]:
            bad = self.edges.copy()
            bad.loc[0, column] += delta
            with self.assertRaisesRegex(ValueError, "edges/transactions"):
                pipeline.sanity_check(bad, self.nodes, self.tx)
        bad = pd.concat([self.nodes, self.nodes.iloc[:1]])
        with self.assertRaisesRegex(ValueError, "дубликаты gid"):
            pipeline.sanity_check(self.edges, bad, self.tx)
        bad = self.edges.copy()
        bad.loc[0, "src"] = -1
        with self.assertRaisesRegex(ValueError, "неизвестный gid"):
            pipeline.sanity_check(bad, self.nodes, self.tx)

    def test_full_registry_and_uncertainty(self):
        self.assertEqual(len(self.df), 2248)
        self.assertEqual(self.df.gid.nunique(), 2248)
        self.assertEqual(int(self.df.is_seed.sum()), 81)
        isolated = self.df[self.df.in_deg.add(self.df.out_deg).eq(0)]
        self.assertEqual(len(isolated), 19)
        self.assertTrue(isolated.priority_score.eq(0).all())
        edge = self.df[self.df.depth.eq(4)]
        self.assertEqual(len(edge), 444)
        self.assertTrue(edge.role.isin(["consolidator", "terminal", "peripheral"]).all())
        self.assertTrue(edge.role_score.le(pipeline.BOUNDARY_CAP).all())
        self.assertTrue(edge.evidence.str.startswith("4-е колено").all())
        self.assertTrue(edge.pass_through.isna().all())
        self.assertTrue(self.df.loc[self.df.is_seed, "pass_through"].isna().all())

    def test_seed_money_is_conserved_and_bounded(self):
        df = self.df
        self.assertAlmostEqual(df.seed_origin_kzt.sum(), df.seed_kept_kzt.sum(), delta=1.0)
        self.assertTrue((df.seed_in_kzt <= df.in_kzt + 0.01).all())
        self.assertTrue((df.seed_out_kzt <= df.out_kzt + 0.01).all())
        self.assertTrue(df.loc[~df.is_seed, "seed_origin_kzt"].abs().le(0.01).all())
        seed_out = self.tx[self.tx.src.isin(self.nodes.gid[self.nodes.is_seed])].sum_kzt.sum()
        self.assertLessEqual(df.seed_origin_kzt.sum(), seed_out + 0.01)

    def test_csv_roundtrip_and_cluster_flow_conservation(self):
        with TemporaryDirectory() as temp:
            pipeline.write_outputs(self.df, self.clusters, self.top, {}, Path(temp), self.nodes, self.edges, 30)
            nodes = pd.read_csv(Path(temp) / "nodes_roles.csv")
            self.assertEqual(nodes.gid.tolist(), self.nodes.gid.tolist())
        membership = self.df.set_index("gid").cluster_id
        cross = self.edges.src.map(membership) != self.edges.dst.map(membership)
        self.assertAlmostEqual(self.clusters.sum_kzt_internal.sum() + self.edges.loc[cross].sum_kzt.sum(),
                               self.edges.sum_kzt.sum(), places=5)
        self.assertEqual(self.clusters.n_nodes.sum(), 2248)
        self.assertEqual(self.clusters.n_seed.sum(), 81)
        self.assertTrue(self.clusters.stability.between(0, 1).all())

    def test_saved_explanations_and_priority_can_be_reproduced(self):
        self.assertEqual(self.top.gid.tolist(), pipeline.ranked(self.df).gid.head(30).tolist())
        w = pipeline.PRIORITY_WEIGHTS
        for r in self.df.itertuples(index=False):
            self.assertEqual((r.role, r.role_score, r.secondary_role), pipeline.choose_role(r))
            self.assertEqual(r.evidence, pipeline.evidence(r))
            expected = (w["money"] * r.money_score + w["sources"] * r.sources_score
                        + w["role"] * pipeline.ROLE_WEIGHTS[r.role] * r.role_score)
            self.assertAlmostEqual(r.priority_score, expected, places=8)

    def test_shuffled_raw_rows_produce_identical_csv(self):
        with TemporaryDirectory() as temp:
            base = Path(temp)
            for name, frame in [("nodes", self.nodes), ("edges", self.edges), ("transactions", self.tx)]:
                frame.sample(frac=1, random_state=7).to_parquet(base / f"{name}.parquet", index=False)
            edges, nodes, tx = pipeline.load(base)
            graph = pipeline.build_graph(edges, nodes)
            cluster_map, stability = pipeline.assign_clusters(graph)
            result = pipeline.score_nodes(pipeline.basic_features(graph, nodes, edges, tx)[0], cluster_map)
            pd.testing.assert_frame_equal(self.df, result)
            pd.testing.assert_frame_equal(self.clusters, pipeline.cluster_outputs(result, edges, stability))
            pd.testing.assert_frame_equal(self.top, pipeline.top_outputs(result, 30))

    def test_validator_rejects_bad_top_or_cluster(self):
        bad_top = self.top.iloc[::-1].reset_index(drop=True)
        with self.assertRaises(ValueError):
            pipeline.validate_outputs(self.df, self.clusters, bad_top, self.nodes, self.edges, 30)
        bad_clusters = self.clusters.copy()
        bad_clusters.loc[0, "sum_kzt_internal"] += 1
        with self.assertRaisesRegex(ValueError, "внутренний оборот"):
            pipeline.validate_outputs(self.df, bad_clusters, self.top, self.nodes, self.edges, 30)

    def test_blocking_more_nodes_never_lets_more_seed_money_through(self):
        table = pipeline.resilience(self.df, self.graph, self.tx, self.nodes)
        self.assertEqual(set(table.scenario), {"top", "top_new"})
        for _, scenario in table.groupby("scenario"):
            self.assertTrue(scenario.seed_kzt_to_others_share.is_monotonic_decreasing)
            self.assertTrue(scenario.seed_kzt_held_share.is_monotonic_increasing)
        self.assertTrue(table[["seed_kzt_to_others_share", "seed_kzt_held_share"]].stack().between(0, 1).all())
        new = table[table.scenario.eq("top_new") & table.removed_top_n.gt(0)]
        seeds = set(self.nodes.gid[self.nodes.is_seed])
        self.assertFalse(any(int(gid) in seeds for gids in new.removed_gids for gid in gids.split(";")))

    def test_boundary_method_beats_base_rate_on_known_depth(self):
        check = pipeline.boundary_backtest(self.df)
        self.assertGreater(check["chosen"], 0)
        self.assertGreater(check["precision"], check["base_rate"])


if __name__ == "__main__":
    unittest.main()
