"""SQLite persistence: watchlists, chart layouts (panes, studies, drawings), alerts, alert log."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  symbols TEXT NOT NULL DEFAULT '[]', updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
  condition TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'once', message TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, last_bar INTEGER, last_fired REAL, expires REAL);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER NOT NULL, fired_at REAL NOT NULL,
  bar_time INTEGER NOT NULL, value REAL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, source TEXT NOT NULL, updated REAL NOT NULL);
"""

# "###NAME" entries are section headers (TradingView's watchlist text format)
DEFAULT_WATCHLIST = ["###CN ETFS", "SSE:510300", "SSE:510500", "SZSE:159915", "SSE:588000",
                     "###US STOCKS", "NASDAQ:AAPL", "NASDAQ:NVDA", "NASDAQ:QQQ", "AMEX:SPY",
                     "###CRYPTO", "BINANCE:BTCUSDT"]


class Store:
    def __init__(self, path: Path | str):
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)
            cols = {r[1] for r in self._db.execute("PRAGMA table_info(alerts)")}
            if "expires" not in cols:   # databases created before alert expiration existed
                self._db.execute("ALTER TABLE alerts ADD COLUMN expires REAL")
            if not self._db.execute("SELECT 1 FROM watchlists").fetchone():
                self._db.execute("INSERT INTO watchlists(name, symbols, updated) VALUES (?,?,?)",
                                 ("Watchlist", json.dumps(DEFAULT_WATCHLIST), time.time()))
            self._db.commit()

    def _q(self, sql: str, args=()) -> list[dict]:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return [dict(r) for r in cur.fetchall()]

    def _exec(self, sql: str, args=()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.lastrowid if cur.lastrowid else cur.rowcount

    # ---- watchlists
    @staticmethod
    def _wl(row: dict) -> dict:
        return {**row, "symbols": json.loads(row["symbols"])}

    def watchlists(self) -> list[dict]:
        return [self._wl(r) for r in self._q("SELECT * FROM watchlists ORDER BY id")]

    def watchlist(self, wid: int) -> dict | None:
        rows = self._q("SELECT * FROM watchlists WHERE id=?", (wid,))
        return self._wl(rows[0]) if rows else None

    def create_watchlist(self, name: str, symbols: list[str] | None = None) -> dict:
        wid = self._exec("INSERT INTO watchlists(name, symbols, updated) VALUES (?,?,?)",
                         (name, json.dumps(_dedupe(symbols or [])), time.time()))
        return self.watchlist(wid)

    def update_watchlist(self, wid: int, name: str | None = None, symbols: list[str] | None = None) -> dict | None:
        cur = self.watchlist(wid)
        if cur is None:
            return None
        self._exec("UPDATE watchlists SET name=?, symbols=?, updated=? WHERE id=?",
                   (name or cur["name"], json.dumps(_dedupe(symbols if symbols is not None else cur["symbols"])),
                    time.time(), wid))
        return self.watchlist(wid)

    def delete_watchlist(self, wid: int) -> bool:
        return self._exec("DELETE FROM watchlists WHERE id=?", (wid,)) > 0

    # ---- layouts
    @staticmethod
    def _layout(row: dict) -> dict:
        return {**row, "state": json.loads(row["state"])}

    def layouts(self) -> list[dict]:
        return self._q("SELECT id, name, updated FROM layouts ORDER BY updated DESC")

    def layout(self, lid: int) -> dict | None:
        rows = self._q("SELECT * FROM layouts WHERE id=?", (lid,))
        return self._layout(rows[0]) if rows else None

    def save_layout(self, name: str, state: dict, lid: int | None = None) -> dict:
        if lid is None:
            existing = self._q("SELECT id FROM layouts WHERE name=?", (name,))
            lid = existing[0]["id"] if existing else None
        if lid is None:
            lid = self._exec("INSERT INTO layouts(name, state, updated) VALUES (?,?,?)",
                             (name, json.dumps(state), time.time()))
        else:
            self._exec("UPDATE layouts SET name=?, state=?, updated=? WHERE id=?",
                       (name, json.dumps(state), time.time(), lid))
        return self.layout(lid)

    def delete_layout(self, lid: int) -> bool:
        return self._exec("DELETE FROM layouts WHERE id=?", (lid,)) > 0

    # ---- alerts
    @staticmethod
    def _alert(row: dict) -> dict:
        return {**row, "condition": json.loads(row["condition"]), "active": bool(row["active"])}

    def alerts(self, active_only: bool = False) -> list[dict]:
        sql = "SELECT * FROM alerts" + (" WHERE active=1" if active_only else "") + " ORDER BY id"
        return [self._alert(r) for r in self._q(sql)]

    def alert(self, aid: int) -> dict | None:
        rows = self._q("SELECT * FROM alerts WHERE id=?", (aid,))
        return self._alert(rows[0]) if rows else None

    def create_alert(self, symbol: str, timeframe: str, condition: dict, trigger: str = "once",
                     message: str = "", last_bar: int | None = None, expires: float | None = None) -> dict:
        aid = self._exec(
            "INSERT INTO alerts(symbol, timeframe, condition, trigger, message, created, last_bar, expires) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (symbol, timeframe, json.dumps(condition), trigger, message, time.time(), last_bar, expires))
        return self.alert(aid)

    def set_alert(self, aid: int, **fields) -> dict | None:
        allowed = {"active", "last_bar", "last_fired", "message", "trigger", "expires"}
        sets = {k: (int(v) if k == "active" else v) for k, v in fields.items() if k in allowed}
        if sets:
            cols = ", ".join(f"{k}=?" for k in sets)
            self._exec(f"UPDATE alerts SET {cols} WHERE id=?", (*sets.values(), aid))
        return self.alert(aid)

    def delete_alert(self, aid: int) -> bool:
        self._exec("DELETE FROM alert_log WHERE alert_id=?", (aid,))
        return self._exec("DELETE FROM alerts WHERE id=?", (aid,)) > 0

    def log_fire(self, aid: int, bar_time: int, value: float | None, message: str) -> dict:
        lid = self._exec("INSERT INTO alert_log(alert_id, fired_at, bar_time, value, message) VALUES (?,?,?,?,?)",
                         (aid, time.time(), bar_time, value, message))
        return self._q("SELECT * FROM alert_log WHERE id=?", (lid,))[0]

    def alert_log(self, limit: int = 200, since_id: int = 0) -> list[dict]:
        return self._q("SELECT * FROM alert_log WHERE id>? ORDER BY id DESC LIMIT ?", (since_id, limit))

    # ---- settings (last-opened layout, UI prefs)
    # ---- user Pine scripts
    def scripts(self) -> list[dict]:
        return self._q("SELECT id, name, updated FROM scripts ORDER BY name")

    def script(self, sid: int) -> dict | None:
        rows = self._q("SELECT * FROM scripts WHERE id=?", (sid,))
        return rows[0] if rows else None

    def save_script(self, name: str, source: str, sid: int | None = None) -> dict:
        if sid is None:
            sid = self._exec("INSERT INTO scripts(name, source, updated) VALUES (?,?,?)", (name, source, time.time()))
        else:
            self._exec("UPDATE scripts SET name=?, source=?, updated=? WHERE id=?", (name, source, time.time(), sid))
        return self.script(sid)

    def delete_script(self, sid: int) -> None:
        self._exec("DELETE FROM scripts WHERE id=?", (sid,))

    def get_setting(self, key: str, default=None):
        rows = self._q("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(rows[0]["value"]) if rows else default

    def set_setting(self, key: str, value) -> None:
        self._exec("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value)))


def _dedupe(symbols: list[str]) -> list[str]:
    seen, out = set(), []
    for s in symbols:
        s = s.strip().upper()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out
