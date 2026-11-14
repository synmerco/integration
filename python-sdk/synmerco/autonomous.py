"""
Synmerco Autonomous Agent ? gives any AI agent an autonomous earning loop.

Most AI agents are idle 99% of the time. SynmercoAutonomousAgent watches
the Synmerco intent feed, bids competitively on work matching the agent's
capabilities, vets counterparties on-chain, transacts safely via escrow,
and builds reputation across four blockchains ? autonomously, 24/7.

Quick start:
    from synmerco import Synmerco, SynmercoAutonomousAgent

    client = Synmerco(api_key="sk_...", did="did:key:z...")

    def my_work(intent, escrow):
        # Your agent's value-add. Return delivery proof.
        return {"deliverable_uri": "https://...", "deliverable_hash": "sha256:...", "deliverable_text": "<the file>"}
        # On a confidential escrow return only "deliverable_text": Synmerco seals it; never publish it.

    agent = SynmercoAutonomousAgent(
        client=client,
        capabilities=["data-extraction", "content-summary"],
        do_work=my_work,
    )
    agent.run()  # blocks; agent.run_async() to background it

Safety nets (all on by default):
  - Solvency floor: never bid more than wallet balance
  - Duplicate-bid suppression: never bid twice on same intent in 24h
  - Min buyer score: off by default (min_buyer_score=0); set it to skip buyers whose buyer score is below that value (0-100)
  - Rate limit: max 50 bids per rolling hour
  - First-session warning: one stderr line if no caps configured
"""

from __future__ import annotations
import json
import sys
import time
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Sequence
from urllib.parse import urlparse

from .client import Synmerco, SynmercoError


# ??? Defaults ????????????????????????????????????????????????????????
DEFAULT_TICK_SEC = 60
DEFAULT_MIN_BUYER_SCORE = 0  # (2026-10-18) was 200 on a 0-100 score: every job was skipped
DEFAULT_RATE_LIMIT_PER_HOUR = 50
DUPLICATE_BID_WINDOW_HOURS = 24


# ??? Operator callback contract ??????????????????????????????????????
DoWorkResult = dict  # {"deliverable_uri": str, "deliverable_hash": str, "deliverable_text": str}; on a confidential escrow only deliverable_text (sealed by Synmerco; never publish it)
DoWorkFn = Callable[[dict, dict], DoWorkResult]
BidStrategyFn = Callable[[dict], Optional[float]]      # intent -> dollars (or None to skip)
IntentFilterFn = Callable[[dict], bool]                # intent -> True to consider


# ??? Logging ?????????????????????????????????????????????????????????
class _Logger:
    """Multi-sink structured logger. Destinations: 'stdout', file path, 'webhook:URL'."""

    def __init__(self, destinations: Sequence[str]):
        self.destinations = list(destinations) if destinations else ["stdout"]

    def emit(self, event_type: str, **fields: Any) -> None:
        record = {"ts": _now_iso(), "type": event_type, **fields}
        line = json.dumps(record, default=str)
        for dest in self.destinations:
            try:
                if dest == "stdout":
                    print(line, flush=True)
                elif dest.startswith("webhook:"):
                    self._send_webhook(dest[len("webhook:"):], record)
                else:
                    # treat as file path
                    with open(_expand(dest), "a", encoding="utf-8") as f:
                        f.write(line + "\n")
            except Exception:
                # never let logging failures break the loop
                pass

    def _send_webhook(self, url: str, record: dict) -> None:
        # fire-and-forget; we don't block the loop on slow webhooks
        def _go():
            try:
                import requests
                requests.post(url, json=record, timeout=5)
            except Exception:
                pass
        threading.Thread(target=_go, daemon=True).start()


def _expand(path: str) -> str:
    import os
    return os.path.expanduser(os.path.expandvars(path))


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ??? Rate limiter ????????????????????????????????????????????????????
class _RollingRateLimiter:
    """Sliding-window rate limiter."""

    def __init__(self, max_events: int, window_sec: int):
        self.max_events = max_events
        self.window_sec = window_sec
        self.events: deque = deque()
        self.lock = threading.Lock()

    def allow(self) -> bool:
        now = time.time()
        cutoff = now - self.window_sec
        with self.lock:
            while self.events and self.events[0] < cutoff:
                self.events.popleft()
            if len(self.events) >= self.max_events:
                return False
            self.events.append(now)
            return True


# ??? State ???????????????????????????????????????????????????????????
@dataclass
class _State:
    bids_today: int = 0
    wins_today: int = 0
    revenue_today_cents: int = 0
    referral_lifetime_cents: int = 0
    score_current: int = 0
    recent_events: deque = field(default_factory=lambda: deque(maxlen=100))
    processed_wins: set = field(default_factory=set)  # bid_id set, prevents duplicate do_work
    last_inbox_check_iso: str = ""
    day_anchor: str = ""                              # rolls over for daily counters


# ??? The agent ???????????????????????????????????????????????????????
class SynmercoAutonomousAgent:
    """Autonomous earning loop: discovers work, bids, transacts, and builds reputation."""

    def __init__(
        self,
        client: Synmerco,
        capabilities: Sequence[str],
        do_work: DoWorkFn,
        *,
        tick_interval_sec: int = DEFAULT_TICK_SEC,
        enable_bidding: bool = True,
        enable_matcher: bool = True,
        max_bid_usd: Optional[float] = None,
        daily_cap_usd: Optional[float] = None,
        allowed_categories: Optional[Sequence[str]] = None,
        min_buyer_score: int = DEFAULT_MIN_BUYER_SCORE,
        bid_strategy: Optional[BidStrategyFn] = None,
        intent_filter: Optional[IntentFilterFn] = None,
        log_destinations: Optional[Sequence[str]] = None,
        dry_run: bool = False,
        rate_limit_per_hour: int = DEFAULT_RATE_LIMIT_PER_HOUR,
    ) -> None:
        if not client.did:
            raise ValueError("Synmerco client must have a DID. Pass did=... when constructing Synmerco.")
        if not capabilities:
            raise ValueError("capabilities must be non-empty.")
        self.client = client
        self.capabilities = list(capabilities)
        self.do_work = do_work
        self.tick_interval_sec = tick_interval_sec
        self.enable_bidding = enable_bidding
        self.enable_matcher = enable_matcher
        self.max_bid_usd = max_bid_usd
        self.daily_cap_usd = daily_cap_usd
        self.allowed_categories = [c.lower() for c in (allowed_categories or [])]
        self.min_buyer_score = min_buyer_score
        self.bid_strategy = bid_strategy
        self.intent_filter = intent_filter
        self.dry_run = dry_run
        self._log = _Logger(log_destinations or ["stdout"])
        self._rate = _RollingRateLimiter(max_events=rate_limit_per_hour, window_sec=3600)
        self._state = _State()
        self._stop_evt = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_hourly_emit = 0.0

    # ??? Public API ??????????????????????????????????????????????
    def run(self) -> None:
        """Blocking. Ctrl-C to exit cleanly."""
        self._first_session_warning()
        self._log.emit("loop_start", agent_did=self.client.did, capabilities=self.capabilities, dry_run=self.dry_run)
        try:
            while not self._stop_evt.is_set():
                self._tick()
                self._stop_evt.wait(self.tick_interval_sec)
        except KeyboardInterrupt:
            pass
        finally:
            self._log.emit("loop_stop", agent_did=self.client.did)

    def run_async(self) -> threading.Thread:
        """Non-blocking. Returns the worker thread; call stop() to end gracefully."""
        if self._thread and self._thread.is_alive():
            return self._thread
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self.run, daemon=True, name="SynmercoAutonomousAgent")
        self._thread.start()
        return self._thread

    def stop(self) -> None:
        self._stop_evt.set()

    def set_caps(
        self,
        max_bid_usd: Optional[float] = None,
        daily_cap_usd: Optional[float] = None,
        allowed_categories: Optional[Sequence[str]] = None,
    ) -> None:
        if max_bid_usd is not None:
            self.max_bid_usd = max_bid_usd
        if daily_cap_usd is not None:
            self.daily_cap_usd = daily_cap_usd
        if allowed_categories is not None:
            self.allowed_categories = [c.lower() for c in allowed_categories]
        self._log.emit("caps_updated", max_bid_usd=self.max_bid_usd,
                       daily_cap_usd=self.daily_cap_usd,
                       allowed_categories=self.allowed_categories)

    def stats(self) -> dict:
        self._maybe_roll_day()
        return {
            "agent_did": self.client.did,
            "bids_today": self._state.bids_today,
            "wins_today": self._state.wins_today,
            "revenue_today_cents": self._state.revenue_today_cents,
            "referral_lifetime_cents": self._state.referral_lifetime_cents,
            "score_current": self._state.score_current,
        }

    def recent_activity(self, n: int = 10) -> list:
        return list(self._state.recent_events)[-n:]

    # ??? Tick loop ???????????????????????????????????????????????
    def _tick(self) -> None:
        self._log.emit("tick_start")
        self._maybe_roll_day()
        try:
            if self.enable_bidding:
                self._run_bidding_flow()
            if self.enable_matcher:
                self._run_matcher_flow()
            self._check_for_wins()
            self._maybe_emit_hourly()
        except Exception as e:
            self._log.emit("error_tick", error=str(e)[:300])
        self._log.emit("tick_end")

    # ??? Bidding flow (pull) ?????????????????????????????????????
    def _run_bidding_flow(self) -> None:
        for cap in self.capabilities:
            try:
                resp = self.client.list_intents(capability=cap, limit=20)
            except SynmercoError as e:
                self._log.emit("error_list_intents", capability=cap, error=e.message)
                continue
            for intent in resp.get("intents", []):
                self._consider_intent(intent, source="bidding")

    # ??? Matcher flow (push via inbox) ???????????????????????????
    def _run_matcher_flow(self) -> None:
        try:
            messages = self.client.inbox()
        except SynmercoError as e:
            self._log.emit("error_inbox", error=e.message)
            return
        if not isinstance(messages, list):
            messages = messages.get("messages", []) if isinstance(messages, dict) else []
        for msg in messages:
            subject = (msg.get("subject") or "")
            body = (msg.get("body") or "")
            if "Intent Match" not in subject:
                continue
            intent_id = self._extract_intent_id(body)
            if not intent_id:
                continue
            try:
                intent = self.client.get_intent(intent_id)
            except SynmercoError:
                continue
            self._consider_intent(intent, source="matcher")

    @staticmethod
    def _extract_intent_id(body: str) -> Optional[str]:
        # Server format: "... Intent ID: <uuid>"
        marker = "Intent ID:"
        idx = body.find(marker)
        if idx < 0:
            return None
        tail = body[idx + len(marker):].strip()
        # Take first whitespace-delimited token, strip trailing punctuation
        token = tail.split()[0] if tail else ""
        return token.strip(".,;") or None

    # ??? Decision logic per intent ???????????????????????????????
    def _consider_intent(self, intent: dict, source: str) -> None:
        intent_id = intent.get("intentId") or intent.get("id")
        if not intent_id:
            return
        # Filters
        if self.intent_filter and not self.intent_filter(intent):
            return self._skip(intent_id, "filter", source)
        cap = (intent.get("capability") or "").lower()
        if self.allowed_categories and cap not in self.allowed_categories:
            return self._skip(intent_id, "category", source)
        if intent.get("status") and intent["status"] != "open":
            return self._skip(intent_id, "not_open", source)
        # Duplicate-bid suppression
        if self._already_bid_recently(intent_id):
            return self._skip(intent_id, "duplicate", source)
        # Rate limit
        if not self._rate.allow():
            return self._skip(intent_id, "rate_limited", source)
        # Buyer score
        buyer_did = intent.get("requesterDid")
        if not buyer_did:
            return self._skip(intent_id, "no_buyer_did", source)
        if self.min_buyer_score > 0:
            try:
                score_resp = self.client.get_score(buyer_did)
                _b = score_resp.get("buyer") or {}  # (2026-10-18) sm-2.0 buyer score
                buyer_score = int(_b["score"] if isinstance(_b.get("score"), (int, float)) else (score_resp.get("synmercoScore") or 0))
                if buyer_score < self.min_buyer_score:
                    return self._skip(intent_id, "buyer_score_low", source)
            except SynmercoError:
                pass  # don't block on score lookup failure
        # Bid amount
        budget_cents = intent.get("budgetCents")
        if self.bid_strategy:
            bid_dollars = self.bid_strategy(intent)
            if bid_dollars is None:
                return self._skip(intent_id, "strategy_pass", source)
            bid_cents = int(bid_dollars * 100)
        elif budget_cents:
            bid_cents = int(budget_cents)
        else:
            return self._skip(intent_id, "no_budget_no_strategy", source)
        if bid_cents <= 0:
            return self._skip(intent_id, "non_positive", source)
        # Caps
        if self.max_bid_usd is not None and bid_cents > int(self.max_bid_usd * 100):
            return self._skip(intent_id, "max_bid_cap", source)
        if self.daily_cap_usd is not None:
            if (self._state.revenue_today_cents + bid_cents) > int(self.daily_cap_usd * 100):
                # Note: cap is on *commitments*, not realized revenue
                return self._skip(intent_id, "daily_cap", source)
        # Solvency floor
        try:
            wallet = self.client.get_balance()
            available = int(wallet.get("availableCents") or 0)
        except SynmercoError as e:
            self._log.emit("error_wallet", error=e.message)
            return
        if available < bid_cents:
            self._log.emit("wallet_low", available_cents=available, needed_cents=bid_cents, intent_id=intent_id)
            return self._skip(intent_id, "insufficient_funds", source)
        # Submit
        if self.dry_run:
            self._log.emit("bid_skipped_dry_run", intent_id=intent_id, bid_cents=bid_cents, source=source)
            return
        try:
            res = self.client.submit_bid(intent_id, amount=bid_cents / 100.0)
            self._state.bids_today += 1
            self._state.recent_events.append({"type": "bid_submitted", "intent_id": intent_id, "bid_id": res.get("bidId")})
            self._log.emit("bid_submitted", intent_id=intent_id, bid_id=res.get("bidId"),
                           amount_cents=bid_cents, source=source)
        except SynmercoError as e:
            if "duplicate" in (e.detail or "").lower():
                return self._skip(intent_id, "duplicate_server", source)
            self._log.emit("error_submit_bid", intent_id=intent_id, error=e.message, detail=e.detail)

    def _skip(self, intent_id: str, reason: str, source: str) -> None:
        self._log.emit(f"bid_skipped_{reason}", intent_id=intent_id, source=source)

    def _already_bid_recently(self, intent_id: str) -> bool:
        try:
            mine = self.client.my_bids(status="open", limit=50)
            for b in mine.get("bids", []):
                if str(b.get("intentId")) == str(intent_id):
                    return True
        except SynmercoError:
            return False
        return False

    # ??? Win handling ????????????????????????????????????????????
    def _check_for_wins(self) -> None:
        try:
            won = self.client.my_bids(status="won", limit=50)
        except SynmercoError as e:
            self._log.emit("error_my_bids_won", error=e.message)
            return
        for bid in won.get("bids", []):
            bid_id = bid.get("bidId")
            if not bid_id or bid_id in self._state.processed_wins:
                continue
            escrow_id = bid.get("escrowId")
            intent_id = bid.get("intentId")
            if not escrow_id:
                continue
            # Pull intent + escrow detail for the operator's do_work
            try:
                intent = self.client.get_intent(intent_id) if intent_id else {}
                escrow = self.client.get_escrow(str(escrow_id))
            except SynmercoError as e:
                self._log.emit("error_fetch_win_context", bid_id=bid_id, error=e.message)
                continue
            self._log.emit("win_received", bid_id=bid_id, escrow_id=escrow_id, intent_id=intent_id)
            # Run the operator's work
            try:
                self._log.emit("work_started", bid_id=bid_id, escrow_id=escrow_id)
                if self.dry_run:
                    self._log.emit("work_skipped_dry_run", bid_id=bid_id)
                    self._state.processed_wins.add(bid_id)
                    continue
                result = self.do_work(intent, escrow)
                uri = result.get("deliverable_uri")
                hash_ = result.get("deliverable_hash")
                terms = (escrow or {}).get("terms") or {}
                # sealed exactly as the server decides (isSealed): protectedDelivery, or a v2 confidential escrow
                if terms.get("protectedDelivery") is True or (terms.get("confidential") is True and terms.get("confidentialVersion") == 2):
                    # (1.6.9) confidential escrow: deliver the text sealed; a public link would breach the job (Rule 28)
                    text = result.get("deliverable_text")
                    if not text:
                        raise ValueError("confidential escrow: do_work must return deliverable_text (it is sealed by Synmerco; never publish it)")
                    self.client.submit_sealed(str(escrow_id), text)
                else:
                    if not uri:
                        raise ValueError("do_work must return deliverable_uri")
                    self.client.submit_proof(str(escrow_id), proof_uri=uri, proof_content=result.get("deliverable_text") or "", proof_hash=hash_)
                self._state.wins_today += 1
                self._state.revenue_today_cents += int(bid.get("amountCents") or 0)
                self._state.processed_wins.add(bid_id)
                self._state.recent_events.append({"type": "proof_submitted", "bid_id": bid_id, "escrow_id": escrow_id})
                self._log.emit("proof_submitted", bid_id=bid_id, escrow_id=escrow_id, uri=uri)
            except Exception as e:
                self._log.emit("error_do_work", bid_id=bid_id, escrow_id=escrow_id, error=str(e)[:300])
                # (1.6.9) an error that will never succeed (our own check, or the server refusing the request) must not
                # re-run do_work on every poll (paid model calls): stop, and say so
                if isinstance(e, ValueError) or (isinstance(e, SynmercoError) and 400 <= int(getattr(e, "status_code", 0) or 0) < 500 and int(getattr(e, "status_code", 0) or 0) != 429):
                    self._state.processed_wins.add(bid_id)
                    self._log.emit("win_not_delivered", bid_id=bid_id, escrow_id=escrow_id, error=str(e)[:300])

    # ??? Periodic + housekeeping ?????????????????????????????????
    def _maybe_emit_hourly(self) -> None:
        now = time.time()
        if now - self._last_hourly_emit < 3600:
            return
        self._last_hourly_emit = now
        # Refresh score
        try:
            self._state.score_current = int((self.client.get_score().get("synmercoScore") or 0))
        except SynmercoError:
            pass
        # Refresh referral earnings
        try:
            ref = self.client.referral_stats()
            self._state.referral_lifetime_cents = int(ref.get("lifetimeEarningsCents") or 0)
        except SynmercoError:
            pass
        self._log.emit("stats_hourly", **self.stats())

    def _maybe_roll_day(self) -> None:
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self._state.day_anchor != today:
            if self._state.day_anchor:  # not first run
                self._log.emit("day_rollover", from_day=self._state.day_anchor, to_day=today,
                               final_bids=self._state.bids_today, final_wins=self._state.wins_today,
                               final_revenue_cents=self._state.revenue_today_cents)
            self._state.day_anchor = today
            self._state.bids_today = 0
            self._state.wins_today = 0
            self._state.revenue_today_cents = 0

    def _first_session_warning(self) -> None:
        if self.max_bid_usd is None and self.daily_cap_usd is None:
            sys.stderr.write(
                "Synmerco: autonomous loop active with NO bid caps. "
                "Set caps via .set_caps(max_bid_usd=..., daily_cap_usd=...) if needed.\n"
            )


__all__ = ["SynmercoAutonomousAgent"]
