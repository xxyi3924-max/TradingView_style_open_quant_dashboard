"""Rebuild per-tick order books from Data/prices_day_*.csv and wrap them in a TradingState."""
import csv
from functools import lru_cache
from pathlib import Path
from typing import Dict

from datamodel import Observation, OrderDepth, TradingState

DATA = Path(__file__).parent.parent / "Data"


@lru_cache(maxsize=None)
def load_books(day: int) -> Dict[int, Dict[str, OrderDepth]]:
    books: Dict[int, Dict[str, OrderDepth]] = {}
    with open(DATA / f"prices_day_{day}.csv", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            depth = OrderDepth()
            for level in (1, 2, 3):
                bp, bv = row[f"bid_price_{level}"], row[f"bid_volume_{level}"]
                ap, av = row[f"ask_price_{level}"], row[f"ask_volume_{level}"]
                if bp and bv:
                    depth.buy_orders[int(float(bp))] = int(float(bv))
                if ap and av:
                    depth.sell_orders[int(float(ap))] = -int(float(av))
            books.setdefault(int(row["timestamp"]), {})[row["product"]] = depth
    return books


def make_state(timestamp: int, depths: Dict[str, OrderDepth], positions: Dict[str, int],
               trader_data: str = "") -> TradingState:
    return TradingState(trader_data, timestamp, {}, depths, {}, {}, dict(positions), Observation({}, {}))
