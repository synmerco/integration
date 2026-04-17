"""Synmerco Python SDK — async-first HTTP client."""

from __future__ import annotations
from typing import Any
import httpx
from pydantic import BaseModel


class Identity(BaseModel):
    did: str
    public_key: str
    created_at: str


class EscrowSummary(BaseModel):
    escrow_id: str
    state: str
    buyer_did: str
    seller_did: str
    amount_cents: int


class ReputationReport(BaseModel):
    did: str
    score: float
    total_events: int


class KycStatus(BaseModel):
    did: str
    status: str | None
    kyc_required: bool
    gate_allowed: bool
    gate_reason: str
    lifetime_funded_cents: int
    threshold_cents: int


class DisputeSummary(BaseModel):
    dispute_id: str
    phase: str
    tier: int
    ruling: str | None = None
    escrow_ruling: str | None = None


class CheckReport(BaseModel):
    check_index: int
    kind: str
    passed: bool
    reason: str


class SynmercoClient:
    """Async client for the Synmerco API."""

    def __init__(
        self,
        base_url: str = "http://localhost:3001",
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> SynmercoClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    # ── Identity ─────────────────────────────────────────────────────

    async def create_identity(self, did: str, public_key: str) -> Identity:
        r = await self._http.post("/v1/identities", json={"did": did, "publicKey": public_key})
        r.raise_for_status()
        return Identity(**r.json())

    async def get_identity(self, did: str) -> Identity:
        r = await self._http.get(f"/v1/identities/{did}")
        r.raise_for_status()
        return Identity(**r.json())

    # ── Reputation ───────────────────────────────────────────────────

    async def get_reputation(self, did: str) -> ReputationReport:
        r = await self._http.get(f"/v1/reputation/{did}")
        r.raise_for_status()
        return ReputationReport(**r.json())

    # ── KYC ──────────────────────────────────────────────────────────

    async def get_kyc_status(self, did: str) -> KycStatus:
        r = await self._http.get("/v1/kyc/status", params={"did": did})
        r.raise_for_status()
        return KycStatus(**r.json())

    async def create_kyc_session(self, did: str) -> dict[str, Any]:
        r = await self._http.post("/v1/kyc/sessions", json={"did": did})
        r.raise_for_status()
        return r.json()

    # ── Disputes ─────────────────────────────────────────────────────

    async def raise_dispute(
        self, escrow_id: str, raised_by: str, respondent: str, reason: str
    ) -> DisputeSummary:
        r = await self._http.post("/v1/disputes", json={
            "escrowId": escrow_id,
            "raisedBy": raised_by,
            "respondent": respondent,
            "reason": reason,
        })
        r.raise_for_status()
        data = r.json()
        return DisputeSummary(
            dispute_id=data["disputeId"],
            phase=data["phase"],
            tier=data["tier"],
        )

    async def get_dispute(self, dispute_id: str) -> dict[str, Any]:
        r = await self._http.get(f"/v1/disputes/{dispute_id}")
        r.raise_for_status()
        return r.json()

    async def submit_evidence(
        self, dispute_id: str, actor: str, evidence_hash: str, evidence_uri: str
    ) -> dict[str, Any]:
        r = await self._http.post(f"/v1/disputes/{dispute_id}/evidence", json={
            "actor": actor,
            "evidenceHash": evidence_hash,
            "evidenceUri": evidence_uri,
        })
        r.raise_for_status()
        return r.json()

    async def dispute_action(
        self, dispute_id: str, action: str, **kwargs: Any
    ) -> DisputeSummary:
        body: dict[str, Any] = {"action": action, **kwargs}
        r = await self._http.post(f"/v1/disputes/{dispute_id}/action", json=body)
        r.raise_for_status()
        data = r.json()
        return DisputeSummary(
            dispute_id=data["disputeId"],
            phase=data["phase"],
            tier=data["tier"],
            ruling=data.get("ruling"),
            escrow_ruling=data.get("escrowRuling"),
        )

    # ── Health ───────────────────────────────────────────────────────

    async def health(self) -> dict[str, str]:
        r = await self._http.get("/health")
        r.raise_for_status()
        return r.json()
