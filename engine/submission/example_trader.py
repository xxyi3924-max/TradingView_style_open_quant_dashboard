"""A deliberately simple example strategy, to show the interface the engine replays (not a competition strategy).

Every tick it quotes one coin inside the best bid and ask of each product, and leans its quotes against its position.
"""
from datamodel import Order, TradingState

SIZE = 5
LIMIT = 20


class Trader:
    def run(self, state: TradingState):
        orders = {}
        for product, depth in state.order_depths.items():
            if not depth.buy_orders or not depth.sell_orders:
                continue
            bid, ask = max(depth.buy_orders), min(depth.sell_orders)
            if ask - bid < 3:
                continue
            pos = state.position.get(product, 0)
            lean = -round(pos / LIMIT)              # long: quote lower, short: quote higher
            mine = []
            if pos < LIMIT:
                mine.append(Order(product, bid + 1 + lean, min(SIZE, LIMIT - pos)))
            if pos > -LIMIT:
                mine.append(Order(product, ask - 1 + lean, -min(SIZE, LIMIT + pos)))
            orders[product] = mine
        return orders, 0, ""
