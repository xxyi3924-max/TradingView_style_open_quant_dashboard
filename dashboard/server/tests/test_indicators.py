"""Indicators vs hand-computed values and independent pandas formulations of the Pine definitions."""
import numpy as np
import pandas as pd
import pytest

from tvre import indicators as ind


def test_sma_hand_values():
    out = ind.sma([1, 2, 3, 4, 5], 3)
    assert np.isnan(out[:2]).all()
    assert out[2:].tolist() == [2.0, 3.0, 4.0]


def test_sma_nan_in_window_is_nan():
    out = ind.sma([1, np.nan, 3, 4, 5, 6], 2)
    assert np.isnan(out[1]) and np.isnan(out[2]) and out[3] == 3.5


def test_ema_seeded_with_sma_then_recursive():
    x = [10.0, 11, 12, 13, 14, 15]
    out = ind.ema(x, 3)
    assert np.isnan(out[:2]).all()
    assert out[2] == pytest.approx(11.0)            # SMA(10,11,12)
    a = 2 / 4
    assert out[3] == pytest.approx(a * 13 + (1 - a) * 11.0)
    assert out[4] == pytest.approx(a * 14 + (1 - a) * out[3])


def test_rma_matches_pandas_ewm_after_seed():
    rng = np.random.default_rng(0)
    x = rng.normal(size=200).cumsum()
    n = 14
    seed = x[:n].mean()
    s = pd.Series(np.r_[seed, x[n:]]).ewm(alpha=1 / n, adjust=False).mean().to_numpy()
    np.testing.assert_allclose(ind.rma(x, n)[n - 1:], s, rtol=1e-12)


def test_rsi_extremes_and_known_value():
    assert np.nanmax(ind.rsi(np.arange(1, 40, dtype=float), 14)[14:]) == 100.0
    assert np.nanmin(ind.rsi(np.arange(40, 1, -1, dtype=float), 14)[14:]) == 0.0
    # alternating +1/-1 changes -> equal average gain/loss -> RSI 50 once seeded
    x = np.cumsum(np.tile([1.0, -1.0], 30))
    assert ind.rsi(x, 14)[-1] == pytest.approx(50.0, abs=4)


def test_rsi_independent_formulation():
    rng = np.random.default_rng(1)
    close = 100 + rng.normal(size=300).cumsum()
    ch = np.diff(close)
    up, dn = np.maximum(ch, 0), np.maximum(-ch, 0)
    n = 14
    au, ad = up[:n].mean(), dn[:n].mean()
    exp = [100 - 100 / (1 + au / ad)]
    for u, d in zip(up[n:], dn[n:]):
        au = (au * (n - 1) + u) / n
        ad = (ad * (n - 1) + d) / n
        exp.append(100 - 100 / (1 + au / ad))
    np.testing.assert_allclose(ind.rsi(close, n)[n:], exp, rtol=1e-10)


def test_macd_components():
    rng = np.random.default_rng(2)
    x = 50 + rng.normal(size=200).cumsum()
    m = ind.macd(x)
    np.testing.assert_allclose(m["macd"], ind.ema(x, 12) - ind.ema(x, 26), equal_nan=True)
    np.testing.assert_allclose(m["hist"], m["macd"] - m["signal"], equal_nan=True)
    assert np.isnan(m["signal"][:33]).all() and np.isfinite(m["signal"][33])   # 26 + 9 - 2


def test_bollinger_population_stdev():
    rng = np.random.default_rng(3)
    x = rng.normal(size=100).cumsum()
    bb = ind.bollinger(x, 20, 2)
    w = x[-20:]
    assert bb["basis"][-1] == pytest.approx(w.mean())
    assert bb["upper"][-1] - bb["basis"][-1] == pytest.approx(2 * w.std(ddof=0))


def test_atr_first_tr_is_range():
    h, l, c = np.array([10, 11, 12.0]), np.array([9, 10, 10.5]), np.array([9.5, 10.8, 11.0])
    tr = ind.true_range(h, l, c)
    assert tr.tolist() == [1.0, 1.5, 1.5]   # bar1: |11 - prev close 9.5| = 1.5 > range 1.0


def test_stoch_bounds():
    rng = np.random.default_rng(4)
    c = 100 + rng.normal(size=120).cumsum()
    s = ind.stoch(c, c + 1, c - 1)
    k = s["k"][~np.isnan(s["k"])]
    assert (k >= 0).all() and (k <= 100).all()


def test_obv_direction():
    assert ind.obv([1, 2, 1, 1, 3], [10, 20, 30, 40, 50]).tolist() == [0, 20, -10, -10, 40]


def test_vwap_resets_per_session():
    out = ind.vwap([2, 4, 6], [2, 4, 6], [2, 4, 6], [1, 1, 1], [0, 0, 1])
    assert out.tolist() == [2.0, 3.0, 6.0]


def test_registry_all_compute_on_frame():
    rng = np.random.default_rng(5)
    c = 100 + rng.normal(size=300).cumsum()
    frame = pd.DataFrame({"time": np.arange(300) * 86400, "open": c, "high": c + 1, "low": c - 1,
                          "close": c, "volume": rng.integers(1, 1000, 300).astype(float)})
    for key in ind.REGISTRY:
        out = ind.compute(key, frame)
        assert out and all(len(v) == 300 for v in out.values()), key
