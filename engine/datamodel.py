"""Types a strategy file sees, in the IMC Prosperity / QuantiFi interface: `from datamodel import Order, OrderDepth,
TradingState`. Written for this repository; field names follow that interface so competition Trader files run unchanged.

Quantities are signed: buys positive, sells negative. In an OrderDepth, buy_orders maps price -> volume (positive) and
sell_orders maps price -> volume (negative).
"""
import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional

Time = int
Symbol = str
Product = str
Position = int
UserId = str
ObservationValue = int


@dataclass
class Listing:
    symbol: Symbol
    product: Product
    denomination: str


@dataclass
class Observation:
    plainValueObservations: Dict[Product, ObservationValue]
    conversionObservations: Dict[Product, object]


@dataclass
class Order:
    symbol: Symbol
    price: int
    quantity: int           # + buy, - sell

    def __repr__(self) -> str:
        return f"({self.symbol}, {self.price}, {self.quantity})"


@dataclass
class OrderDepth:
    buy_orders: Dict[int, int] = field(default_factory=dict)    # price -> volume (> 0)
    sell_orders: Dict[int, int] = field(default_factory=dict)   # price -> volume (< 0)


@dataclass
class Trade:
    symbol: Symbol
    price: int
    quantity: int
    buyer: Optional[UserId] = None
    seller: Optional[UserId] = None
    timestamp: Time = 0


@dataclass
class TradingState:
    traderData: str                             # the string the Trader returned last tick
    timestamp: Time
    listings: Dict[Symbol, Listing]
    order_depths: Dict[Symbol, OrderDepth]
    own_trades: Dict[Symbol, List[Trade]]       # our fills since the last tick
    market_trades: Dict[Symbol, List[Trade]]    # other traders' trades since the last tick
    position: Dict[Product, Position]
    observations: Observation

    def toJSON(self) -> str:
        return json.dumps(self, default=lambda o: o.__dict__, sort_keys=True)
