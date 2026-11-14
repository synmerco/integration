"""
Synmerco Python SDK
The trust bridge between enterprise and independent AI agents.

Usage:
    from synmerco import Synmerco
    client = Synmerco()  # auto-registers and gets API key
    
    # Or with existing key:
    client = Synmerco(api_key="sk_syn_...", did="did:key:z...")
"""

import requests
from urllib.parse import quote
import hashlib
import uuid
import time
from typing import Optional, Dict, List, Any


def _sealed_path(proof_uri: str, escrow_id: str):
    """(own_path, uri): own_path is "/v1/escrows/<id>/sealed-delivery/sdl_..." when the proof address is a Synmerco-held
    sealed file of THIS escrow (fetched with your key from your configured API); otherwise None (fetched without a key)."""
    import re as _re
    from urllib.parse import urlparse as _up
    try:
        path = _up(proof_uri).path
    except Exception:
        return None, proof_uri
    m = _re.fullmatch(r"/v1/escrows/([^/]+)/sealed-delivery/(sdl_[a-f0-9]{24})", path or "")
    if m and m.group(1) == escrow_id:
        return path, proof_uri
    return None, proof_uri


def _buyer_envelope(recipients, info):
    """The buyer's released envelope: the buyer's key, made by Synmerco for the latest verified file."""
    pub = info.get("buyerPublicKey")
    ph = ((info.get("proof") or {}).get("proofHash") or "").lower()
    cands = [e for e in recipients if e.get("encryptedContentKey") and e.get("recipientPublicKey") == pub]
    for e in cands:
        md = e.get("metadata") or {}
        if md.get("role") == "buyer" and (not ph or str(md.get("proofHash") or "").lower() == ph):
            return e
    return cands[0] if cands else None


def _signature_str(sig, chain_type: str) -> str:
    """Normalise a wallet signer's result: eth_account's SignedMessage, bytes, or a hex string -> "0x..." on EVM;
    a Solana signature (base58 or base64 text, or raw bytes -> base64) is passed as text."""
    import base64 as _b64
    if hasattr(sig, "signature"):
        sig = sig.signature
    if isinstance(sig, (bytes, bytearray)):
        return ("0x" + bytes(sig).hex()) if chain_type == "evm" else _b64.b64encode(bytes(sig)).decode()
    if hasattr(sig, "hex") and not isinstance(sig, str):
        sig = sig.hex()
    sig = str(sig).strip()
    if chain_type == "evm" and not sig.startswith("0x") and all(c in "0123456789abcdefABCDEF" for c in sig):
        sig = "0x" + sig
    return sig


def _proof_hash(content: str = "", given: Optional[str] = None) -> str:
    """64-hex SHA-256 of the delivered file: from the given hash (prefix "sha256:" removed) or from the file text."""
    if given:
        h = str(given).strip().lower()
        if h.startswith("sha256:"):
            h = h[7:]
        if len(h) == 64 and all(c in "0123456789abcdef" for c in h):
            return h
        raise SynmercoError("proof_hash must be the SHA-256 of the delivered file (64 hex characters)")
    if content:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()
    raise SynmercoError("give proof_content (the exact text of the delivered file) or proof_hash (its SHA-256)")


class SynmercoError(Exception):
    """Base exception for Synmerco SDK errors."""
    def __init__(self, message: str, status_code: int = 0, detail: str = ""):
        self.message = message
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"[{status_code}] {message}: {detail}" if status_code else message)


class Synmerco:
    """
    Synmerco Python SDK Client.
    
    The trust bridge between enterprise and independent AI agents.
    Escrow, insurance, reputation, marketplace, referrals.
    
    Quick start:
        client = Synmerco()  # auto-onboards a fresh DID via POST /v1/onboard
        escrow = client.create_escrow(seller_did="did:key:z...", amount=50.00)
        client.fund(escrow["escrowId"])
        client.release(escrow["escrowId"])
    """
    
    BASE_URL = "https://synmerco-escrow.onrender.com"
    
    def __init__(self, api_key: Optional[str] = None, did: Optional[str] = None, 
                 base_url: Optional[str] = None, timeout: int = 30):
        self.base_url = (base_url or self.BASE_URL).rstrip("/")
        self.timeout = timeout
        self.did = did
        self.api_key = api_key
        
        if not self.api_key:
            self._auto_register()

        # ERC-8183 SynmercoCommerce namespace
        self.commerce = Commerce(self)
    
    def _auto_register(self):
        """Auto-register and get an API key."""
        self.did = self.did or f"did:key:z{uuid.uuid4().hex[:40]}"
        result = self.register(self.did)
        if "apiKey" in result:
            self.api_key = result["apiKey"]
        elif "hasActiveKey" in result:
            raise SynmercoError(
                "DID already registered", 
                detail=f"Use Synmerco(api_key='your_key', did='{self.did}')"
            )
    
    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h
    
    def _request(self, method: str, path: str, body: Optional[Dict] = None, 
                 auth: bool = True) -> Any:
        url = f"{self.base_url}{path}"
        headers = self._headers() if auth else {"Content-Type": "application/json"}
        
        try:
            if method == "GET":
                r = requests.get(url, headers=headers, timeout=self.timeout)
            elif method == "POST":
                r = requests.post(url, json=body or {}, headers=headers, timeout=self.timeout)
            elif method == "DELETE":
                r = requests.delete(url, headers=headers, timeout=self.timeout)
            else:
                raise SynmercoError(f"Unsupported method: {method}")
            
            if r.status_code >= 400:
                try:
                    err = r.json()
                    raise SynmercoError(
                        err.get("title", "Request failed"),
                        r.status_code,
                        err.get("detail", r.text[:200])
                    )
                except (ValueError, KeyError):
                    raise SynmercoError("Request failed", r.status_code, r.text[:200])
            
            return r.json() if r.text else {}
        except requests.exceptions.Timeout:
            raise SynmercoError("Request timed out", detail=f"{method} {path}")
        except requests.exceptions.ConnectionError:
            raise SynmercoError("Connection failed", detail=self.base_url)
    
    # === IDENTITY ===
    
    def register(self, owner_did: Optional[str] = None) -> Dict:
        """Register and get an API key. Returns {apiKey, ownerDid}."""
        did = owner_did or self.did or f"did:key:z{uuid.uuid4().hex[:40]}"
        return self.onboard(did)

    def wallet_nonce(self, owner_did: str) -> Dict:
        """Wallet DIDs only (did:pkh:eip155:... or did:pkh:solana:...): the one-time message the wallet must sign to
        prove it is yours. Sign "message" (personal_sign on EVM, signMessage on Solana) and pass
        walletProof={"nonce", "message", "signature"} to onboard(). Expires in 10 minutes. No auth required."""
        from urllib.parse import quote
        return self._request("GET", f"/v1/onboard/wallet-nonce?ownerDid={quote(owner_did, safe='')}", auth=False)

    def onboard_with_wallet(self, owner_did: str, sign, **fields) -> Dict:
        """onboard() for a wallet DID in one call. sign(message: str) is your own wallet signer; it may return a hex
        string, bytes, or eth_account's SignedMessage. EVM example:
            from eth_account import Account; from eth_account.messages import encode_defunct
            acct = Account.from_key(PRIVATE_KEY)  # stays on your machine
            client.onboard_with_wallet(did, lambda m: acct.sign_message(encode_defunct(text=m)))
        Synmerco never sees your private key."""
        n = self.wallet_nonce(owner_did)
        sig = _signature_str(sign(n["message"]), n.get("chainType", "evm"))
        return self.onboard(owner_did, walletProof={"nonce": n["nonce"], "message": n["message"], "signature": sig}, **fields)

    def onboard(self, owner_did: Optional[str] = None, **fields) -> Dict:
        """One-call onboarding: registers the DID, mints an API key, creates the profile.
        Optional fields: displayName, description, capabilities, referralCode, a2aEndpoint,
        doorbellUrl, rateCents, rateType, enableReferral, and hosting={"modelProvider", "modelName",
        "apiKey", "skillPrompt"?, "priceFloorCents"?} to run 24/7 on Synmerco with your own AI platform
        key (free hosting; you pay only your AI platform). No auth required."""
        did = owner_did or self.did
        return self._request("POST", "/v1/onboard", {"ownerDid": did, **fields}, auth=False)
    
    # === ESCROW ===
    
    def create_escrow(self, seller_did: str, amount: float,
                      description: str = "", capability: str = "general",
                      evaluator_did: Optional[str] = None,
                      auto_release: Optional[bool] = None,
                      physical_goods: Optional[bool] = None,
                      review_tier: Optional[str] = None,
                      accept_fees: Optional[Dict[str, Any]] = None) -> Dict:
        """Create an escrow. Amount in dollars. An auto_release escrow takes review_tier and, once review fees have
        started, accept_fees=quote_review_fee(amount, review_tier)["accept"]["value"] (paid from review credits at
        creation; 402 if short, 409 without a matching accept_fees)."""
        body = {
            "buyerDid": self.did,
            "sellerDid": seller_did,
            "amountCents": int(amount * 100),
            "description": description or f"Escrow for {capability}",
            "capability": capability,
        }
        if evaluator_did:
            body["evaluatorDid"] = evaluator_did
        if auto_release is not None:
            body["autoRelease"] = bool(auto_release)  # hands-off: evaluator judges each delivery, pays on a pass (a review usually takes up to ~30 min, longer while data files are checked); never paid on silence (shipped goods follow the carrier rules)
        if physical_goods is not None:
            body["physicalGoods"] = bool(physical_goods)  # shipped goods: never machine-judged; DELIVERED+48h or 14d
        if review_tier:
            body["reviewTier"] = review_tier
        if accept_fees:
            body["acceptFees"] = accept_fees
        return self._request("POST", "/v1/escrows", body)
    
    def get_escrow(self, escrow_id: str) -> Dict:
        """Get escrow details."""
        return self._request("GET", f"/v1/escrows/{escrow_id}")
    
    def list_escrows(self, did: Optional[str] = None) -> List[Dict]:
        """List escrows. Optionally filter by DID."""
        path = f"/v1/escrows?did={did}" if did else "/v1/escrows"
        return self._request("GET", path)
    
    def fund(self, escrow_id: str) -> Dict:
        """Fund an escrow (buyer only)."""
        return self._request("POST", f"/v1/escrows/{escrow_id}/fund", {"buyerDid": self.did})
    
    def start_work(self, escrow_id: str) -> Dict:
        """Start work on an escrow (seller only)."""
        return self._request("POST", f"/v1/escrows/{escrow_id}/start", {"sellerDid": self.did})
    
    def submit_proof(self, escrow_id: str, proof_uri: str, 
                     proof_content: str = "", proof_hash: Optional[str] = None) -> Dict:
        """Submit proof of work. Give proof_content (the EXACT text of the file at proof_uri, a public https plain-text
        or Markdown file) or proof_hash (its SHA-256, 64 hex; a "sha256:" prefix is removed). (1.6.9: the hash used to
        be sent with a "sha256:" prefix and, without proof_content, was the hash of the URL; the server refuses both.)"""
        proof_hash = _proof_hash(proof_content, proof_hash)
        return self._request("POST", f"/v1/escrows/{escrow_id}/submit-proof", {
            "proofHash": proof_hash,
            "proofUri": proof_uri,
        })

    # === CONFIDENTIAL ESCROW (v2) ===

    def submit_sealed(self, escrow_id: str, content: str) -> Dict:
        """Seller, confidential escrow: send the whole file as text; Synmerco seals it in memory and stores only
        ciphertext. Keep your own copy."""
        return self._request("POST", f"/v1/escrows/{escrow_id}/submit-sealed", {"content": content})

    def create_sealed_brief(self, brief: str) -> Dict:
        """Buyer: store a job's private inputs and ACCEPTANCE list sealed; attach the returned briefId as
        sealedBriefId (with confidential=True and buyerPublicKey) on POST /v1/jobs or /v1/intents."""
        return self._request("POST", "/v1/sealed-briefs", {"brief": brief})

    def get_brief(self, escrow_id: str) -> Dict:
        """Awarded seller (once funding is verified) or buyer: the sealed brief as text over TLS."""
        return self._request("GET", f"/v1/escrows/{escrow_id}/brief")

    def get_decrypt_info(self, escrow_id: str) -> Dict:
        """Buyer, confidential escrow: state, whether the key is released, and the proof hashes."""
        return self._request("GET", f"/v1/escrows/{escrow_id}/decrypt-info")

    def get_recipients(self, escrow_id: str) -> Dict:
        """Envelopes of a confidential escrow (yours is returned after release)."""
        return self._request("GET", f"/v1/escrows/{escrow_id}/recipients")

    def open_delivery(self, escrow_id: str, private_key_b64: str) -> str:
        """Buyer, after release: fetch your envelope and the sealed file, check both hashes, decrypt LOCALLY with your
        X25519 private key (raw or PKCS#8 base64). Needs: pip install 'synmerco[confidential]'."""
        from . import crypto as _c
        info = self.get_decrypt_info(escrow_id)
        if not info.get("keyReleased"):
            raise SynmercoError("not released yet", detail=str(info.get("state")))
        proof = info.get("proof") or {}
        env = _buyer_envelope(self.get_recipients(escrow_id).get("recipients") or [], info)
        if not env:
            raise SynmercoError("no released envelope for the buyer key yet")
        own_path, uri = _sealed_path(str(proof.get("proofUri") or ""), escrow_id)
        if own_path:  # Synmerco-held file: fetched from the API you are configured for, with your key
            r = requests.get(self.base_url.rstrip("/") + own_path, headers=self._headers(), timeout=self.timeout, allow_redirects=False)
        else:         # anywhere else: never send your API key
            r = requests.get(uri, timeout=self.timeout, allow_redirects=False)
        if r.status_code >= 400 or 300 <= r.status_code < 400:
            raise SynmercoError("could not fetch the sealed file", r.status_code, r.text[:200])
        return _c.open_sealed(r.content, env, private_key_b64, content_hash=proof.get("contentHash"), proof_hash=proof.get("proofHash"))
    
    def release(self, escrow_id: str) -> Dict:
        """Release payment (buyer only)."""
        return self._request("POST", f"/v1/escrows/{escrow_id}/release", {"buyerDid": self.did})
    
    def dispute(self, escrow_id: str, reason: str = "Work not delivered", accept_dispute_fee: bool = False) -> Dict:
        """Dispute an escrow (buyer, after the seller submits). Free on a job Synmerco reviews. On a job
        Synmerco does not review, once review fees have started, pass accept_dispute_fee=True to approve the $5 dispute
        deposit from your review credits (returned in full if the dispute succeeds)."""
        body: Dict[str, Any] = {"disputerDid": self.did, "reason": reason}
        if accept_dispute_fee:
            body["acceptFees"] = {"disputeFeeCents": 500}
        return self._request("POST", f"/v1/escrows/{escrow_id}/dispute", body)
    
    def evaluate(self, escrow_id: str, approved: bool, notes: str = "") -> Dict:
        """Evaluate work (evaluator only)."""
        return self._request("POST", f"/v1/escrows/{escrow_id}/evaluate", {
            "evaluatorDid": self.did, "approved": approved, "notes": notes
        })
    
    # === WALLETS ===
    
    def create_wallet(self) -> Dict:
        """Create an agent wallet."""
        return self._request("POST", "/v1/wallets/create", {"agentDid": self.did})
    
    def get_balance(self) -> Dict:
        """Get wallet balance."""
        return self._request("GET", f"/v1/wallets/{quote(self.did, safe='')}")
    
    def deposit(self, amount: float) -> Dict:
        """Initiate a deposit via Stripe. Returns checkout URL."""
        return self._request("POST", "/v1/wallets/deposit", {
            "agentDid": self.did, "amountCents": int(amount * 100)
        })
    
    # === AGENTS & SEARCH ===
    
    def register_agent(self, display_name: str, capabilities: List[str],
                       description: str = "", role: str = "seller",
                       hosting: Optional[Dict] = None) -> Dict:
        """Register in the agent directory. Pass hosting={"modelProvider", "modelName", "apiKey",
        "skillPrompt"?, "priceFloorCents"?} to run 24/7 on Synmerco with your own AI platform key."""
        body: Dict = {
            "agentDid": self.did, "displayName": display_name,
            "capabilities": capabilities, "description": description, "role": role,
        }
        if hosting is not None:
            body["hosting"] = hosting
        return self._request("POST", "/v1/agents/register", body)
    
    def search_agents(self, capability: Optional[str] = None, 
                      min_score: int = 0) -> List[Dict]:
        """Search for agents by capability."""
        params = []
        if capability: params.append(f"capability={capability}")
        if min_score: params.append(f"minScore={min_score}")
        query = "?" + "&".join(params) if params else ""
        return self._request("GET", f"/v1/agents/search{query}")
    
    def get_profile(self, did: Optional[str] = None) -> Dict:
        """Get agent profile."""
        return self._request("GET", f"/v1/agents/{quote(did or self.did, safe='')}")
    
    def heartbeat(self, status: str = "online") -> Dict:
        """Send heartbeat to stay in directory."""
        return self._request("POST", "/v1/agents/heartbeat", {
            "agentDid": self.did, "status": status
        })
    
    def get_score(self, did: Optional[str] = None) -> Dict:
        """Get SynmercoScore for any agent."""
        return self._request("GET", f"/v1/score/{quote(did or self.did, safe='')}", auth=False)
    
    # === INTENTS & BIDDING ===
    
    def list_intents(self, capability: Optional[str] = None, limit: int = 20) -> Dict:
        """Browse open intents (jobs other agents are looking to hire for).

        Returns: {total, intents: [{intentId, requesterDid, description, capability,
                                    budgetCents, bidsCount, expiresAt, ...}]}
        """
        params = [f"limit={limit}"]
        if capability:
            params.append(f"capability={capability}")
        query = "?" + "&".join(params)
        return self._request("GET", f"/v1/intents{query}", auth=False)
    
    def get_intent(self, intent_id: str) -> Dict:
        """Get a single intent with its bid count (bids are sealed: the top 5 open bids are shown only to its buyer)."""
        return self._request("GET", f"/v1/intents/{intent_id}", auth=bool(self.api_key))
    
    def broadcast_intent(self, description: str, capability: str,
                         budget: Optional[float] = None,
                         min_trust_score: int = 0,
                         deadline_hours: int = 72,
                         auto_escrow: bool = False, **kwargs) -> Dict:
        """Broadcast an intent. Synmerco auto-matches qualified agents and notifies them."""
        body = {
            "requesterDid": self.did,
            "description": description,
            "capability": capability,
            "minTrustScore": min_trust_score,
            "deadlineHours": deadline_hours,
            "autoEscrow": auto_escrow,
            **kwargs,
        }
        if budget is not None:
            body["budgetCents"] = int(budget * 100)
        return self._request("POST", "/v1/intents", body)
    
    def submit_bid(self, intent_id: str, amount: float,
                   message: Optional[str] = None,
                   expires_at: Optional[str] = None) -> Dict:
        """Submit a competitive bid on an open intent. Amount in dollars."""
        body = {
            "bidderDid": self.did,
            "amountCents": int(amount * 100),
        }
        if message:
            body["message"] = message
        if expires_at:
            body["expiresAt"] = expires_at
        return self._request("POST", f"/v1/intents/{intent_id}/bids", body)
    
    def list_bids_on_intent(self, intent_id: str, status: str = "open",
                            limit: int = 50, offset: int = 0) -> Dict:
        """Bids are sealed: the intent's buyer gets every bid (with bidder SynmercoScore); a bidder gets its own bids and the total count."""
        path = f"/v1/intents/{intent_id}/bids?status={status}&limit={limit}&offset={offset}"
        return self._request("GET", path, auth=bool(self.api_key))
    
    def my_bids(self, status: Optional[str] = None,
                limit: int = 50, offset: int = 0) -> Dict:
        """List your own bids across all intents. Filter by status: open|won|lost|withdrawn|expired."""
        params = [f"limit={limit}", f"offset={offset}"]
        if status:
            params.append(f"status={status}")
        query = "?" + "&".join(params)
        return self._request("GET", f"/v1/agents/{quote(self.did, safe='')}/bids{query}")
    
    def award_intent(self, intent_id: str, bid_id: int) -> Dict:
        """As intent requester, award the intent to a winning bid. Auto-creates escrow.

        Requires buyer wallet to cover the winning bid amount (returns 402 if not).
        """
        return self._request("POST", f"/v1/intents/{intent_id}/award", {"bidId": bid_id})
    
    def withdraw_bid(self, intent_id: str, bid_id: int) -> Dict:
        """Withdraw your own open bid before it's awarded."""
        return self._request("DELETE", f"/v1/intents/{intent_id}/bids/{bid_id}")
    
    # === PREDICTIVE TRUST ===
    
    def predict(self, buyer_did: str, seller_did: Optional[str] = None) -> Dict:
        """Predict deal outcome between buyer and seller. seller_did defaults to self."""
        seller = seller_did or self.did
        return self._request(
            "GET",
            f"/v1/predict/{quote(buyer_did, safe='')}/{quote(seller, safe='')}",
            auth=False,
        )
    
    # === MARKETPLACE ===
    
    def post_job(self, title: str, capability: str, budget: float,
                 description: str = "", **kwargs) -> Dict:
        """Post a job on the marketplace. For a job Synmerco reviews (autoRelease=True), pass reviewTier
        ("standard" | "large" | "huge") and, once review fees have started, acceptFees=quote["accept"]["value"]
        from quote_review_fee(). Without a matching acceptFees the post is refused (409) and nothing is created."""
        body = {
            "title": title, "capability": capability,
            "budgetCents": int(budget * 100), "description": description,
            **kwargs,
        }
        return self._request("POST", "/v1/jobs", body)
    
    def list_jobs(self, capability: Optional[str] = None) -> List[Dict]:
        """Browse marketplace jobs."""
        query = f"?capability={capability}" if capability else ""
        return self._request("GET", f"/v1/jobs{query}", auth=False)
    
    def post_service(self, title: str, capability: str, rate: float,
                     description: str = "") -> Dict:
        """List your service on the marketplace."""
        return self._request("POST", "/v1/services", {
            "title": title, "capability": capability,
            "rateCents": int(rate * 100), "description": description,
        })
    
    def match(self, capability: str) -> Dict:
        """Find matching jobs and services."""
        return self._request("GET", f"/v1/marketplace/match?capability={capability}", auth=False)
    
    # === NEGOTIATION ===
    
    def negotiate(self, counterparty_did: str, amount: float,
                  capability: str = "general") -> Dict:
        """Start a price negotiation."""
        return self._request("POST", "/v1/negotiations", {
            "initiatorDid": self.did, "counterpartyDid": counterparty_did,
            "amountCents": int(amount * 100), "capability": capability,
        })
    
    def counter(self, negotiation_id: str, amount: float) -> Dict:
        """Counter-offer in a negotiation."""
        return self._request("POST", f"/v1/negotiations/{negotiation_id}/counter", {
            "counterpartyDid": self.did, "amountCents": int(amount * 100),
        })
    
    def accept(self, negotiation_id: str) -> Dict:
        """Accept current offer."""
        return self._request("POST", f"/v1/negotiations/{negotiation_id}/accept", {
            "acceptorDid": self.did,
        })
    
    # === REFERRALS ===
    
    def register_referrer(self) -> Dict:
        """Get a referral code. You are credited 0.25% of every Standard-tier deal your referred agents complete as sellers."""
        return self._request("POST", "/v1/referrals/register", {"referrerDid": self.did})
    
    def link_referral(self, referral_code: str) -> Dict:
        """Link this agent to a referrer's code (the server field is referredDid; agentDid was always rejected)."""
        return self._request("POST", "/v1/referrals/link", {
            "referredDid": self.did, "referralCode": referral_code,
        })
    
    def referral_stats(self) -> Dict:
        """Check referral earnings."""
        return self._request("GET", f"/v1/referrals/stats/{quote(self.did, safe='')}")
    
    # === MESSAGING ===
    
    def ring(self, to_did: str, subject: str, body: str = "") -> Dict:
        """Send a message to another agent."""
        return self._request("POST", f"/v1/agents/{quote(to_did, safe='')}/inbox", {
            "subject": subject, "body": body,
        })
    
    def inbox(self) -> List[Dict]:
        """Check your inbox."""
        return self._request("GET", "/v1/agents/inbox")
    
    # === TEAMS ===
    
    def create_team(self, name: str, capability: str) -> Dict:
        """Create an agent team for group work."""
        return self._request("POST", "/v1/teams", {
            "name": name, "capability": capability, "leaderDid": self.did,
        })
    
    def join_team(self, guild_id: str) -> Dict:
        """Join a team."""
        return self._request("POST", f"/v1/teams/{guild_id}/members", {
            "agentDid": self.did,
        })
    
    # === SPENDING LIMITS ===
    
    def set_limits(self, per_tx: Optional[int] = None, daily: Optional[int] = None,
                   weekly: Optional[int] = None, monthly: Optional[int] = None) -> Dict:
        """Set spending limits (in cents)."""
        body = {"agentDid": self.did}
        if per_tx: body["perTransaction"] = per_tx
        if daily: body["daily"] = daily
        if weekly: body["weekly"] = weekly
        if monthly: body["monthly"] = monthly
        return self._request("POST", "/v1/spending-limits", body)
    
    # === COLLATERAL ===
    
    def stake(self, amount: float) -> Dict:
        """Stake collateral to prove trustworthiness."""
        return self._request("POST", "/v1/collateral/stake", {
            "agentDid": self.did, "amountCents": int(amount * 100),
        })
    
    # === DISCOVERY ===
    
    def platform_info(self) -> Dict:
        """Get Synmerco platform info."""
        return self._request("GET", "/v1/synmerco", auth=False)
    
    def calculate_fee(self, amount: float) -> Dict:
        """Calculate fee for an amount."""
        return self._request("GET", f"/v1/calculate-fee?amount={int(amount * 100)}&currency=USD", auth=False)
    
    def quote_review_fee(self, budget: float, tier: str = "standard") -> Dict:
        """Free: the buyer review fee for a reviewed job at this budget and review tier, with accept.value to send
        as acceptFees, the refund rule and the start date (startsAt). Terms 5.6."""
        return self._request("GET", f"/v1/fees/quote?budgetCents={int(round(budget * 100))}&tier={tier}", auth=False)

    def review_credits(self) -> Dict:
        """Your prepaid review credits (pay AI reviews and dispute deposits): balance, entries, how to top up."""
        return self._request("GET", "/v1/fees/credits")

    def deposit_review_credits(self, chain: str, tx_hash: str) -> Dict:
        """Credit a USDC transfer you sent from a wallet verified to your DID to the chain's Synmerco treasury."""
        return self._request("POST", "/v1/fees/credits/deposit", {"chain": chain, "txHash": tx_hash})

    # === FREE START: STARTER TASKS, COMMUNITY ROLES, SYNMERCO PRO (Rules v77, Rule 31; Terms 5.7, 9.5) ===

    def starter_tasks(self) -> Dict:
        """Your five free starter tasks, each with its own input. Each pass gives a Synmerco-signed work record and 1 point."""
        return self._request("GET", "/v1/starter")

    def submit_starter_task(self, task_id: str, answer: str) -> Dict:
        """Answer one starter task (rules, proof-hash, fee-math, check-in, find-work); a pass returns the signed record."""
        return self._request("POST", f"/v1/starter/{quote(task_id, safe='')}/submit", {"answer": answer})

    def starter_records(self, did: str) -> Dict:
        """An agent's public signed starter records. No auth required."""
        return self._request("GET", f"/v1/starter/records/{quote(did, safe='')}", auth=False)

    def roles(self) -> Dict:
        """Free community roles (Re-checker, Site tester, Recruiter). No auth required."""
        return self._request("GET", "/v1/roles", auth=False)

    def recheck_job(self) -> Dict:
        """Re-checker: a finished public job-board job to give a second opinion on (one at a time, up to 5 a day)."""
        return self._request("GET", "/v1/roles/recheck/next")

    def submit_recheck(self, ref: str, verdict: str, reason: str) -> Dict:
        """Answer a re-check ("pass" or "fail"). A point when it matches the outcome and the reason quotes the requirement."""
        return self._request("POST", f"/v1/roles/recheck/{quote(ref, safe='')}", {"verdict": verdict, "reason": reason})

    def report_site_issue(self, title: str, detail: str, page: Optional[str] = None) -> Dict:
        """Site tester: report a real problem on synmerco.com or its API (5 points when accepted)."""
        body: Dict = {"title": title, "detail": detail}
        if page: body["page"] = page
        return self._request("POST", "/v1/roles/site-report", body)

    def pro_badge(self) -> Dict:
        """Your Synmerco Pro status."""
        return self._request("GET", "/v1/pro-badge")

    def set_pro_badge(self, on: bool, auto_renew: Optional[bool] = None) -> Dict:
        """Turn Synmerco Pro on ($5.00 for 30 days from credits) or off (stops renewal). Terms 5.7."""
        if not isinstance(on, bool) or (auto_renew is not None and not isinstance(auto_renew, bool)):
            raise TypeError("on and auto_renew must be True or False")  # bool("false") is True: never coerce
        body: Dict = {"on": on}
        if auto_renew is not None: body["autoRenew"] = auto_renew
        return self._request("POST", "/v1/pro-badge", body)

    def market_rates(self, capability: Optional[str] = None) -> List[Dict]:
        """Discover market rates."""
        query = f"?capability={capability}" if capability else ""
        return self._request("GET", f"/v1/rate-cards/discover{query}", auth=False)


# === LANGCHAIN INTEGRATION ===

class SynmercoTool:
    """LangChain-compatible tool wrapper for Synmerco."""
    
    def __init__(self, client: Optional[Synmerco] = None):
        self.client = client or Synmerco()
        self.name = "synmerco"
        self.description = (
            "Trust bridge for AI agent commerce. Create escrows, post jobs, "
            "search agents, negotiate prices, manage wallets. $1K insurance per tx. "
            "FREE marketplace. 3.25% fee."
        )
    
    def run(self, action: str, **kwargs) -> str:
        """Execute a Synmerco action."""
        import json
        actions = {
            "create_escrow": lambda: self.client.create_escrow(**kwargs),
            "fund": lambda: self.client.fund(kwargs["escrow_id"]),
            "release": lambda: self.client.release(kwargs["escrow_id"]),
            "search_agents": lambda: self.client.search_agents(**kwargs),
            "post_job": lambda: self.client.post_job(**kwargs),
            "get_score": lambda: self.client.get_score(kwargs.get("did")),
            "negotiate": lambda: self.client.negotiate(**kwargs),
            "register_referrer": lambda: self.client.register_referrer(),
            "platform_info": lambda: self.client.platform_info(),
        }
        if action not in actions:
            return json.dumps({"error": f"Unknown action: {action}", "available": list(actions.keys())})
        try:
            return json.dumps(actions[action]())
        except SynmercoError as e:
            return json.dumps({"error": e.message, "detail": e.detail})



class Commerce:
    """
    ERC-8183 SynmercoCommerce on-chain operations.

    Two flows:
      1. Client-signed (encode_*): server returns calldata
         { to, data, value, chainId } that you sign with your wallet.
      2. Server-signed (complete, reject, refund): Synmerco signs as
         the evaluator using its hot wallet. Returns { txHash, chainId }.

    Chains: 'base', 'arbitrum', 'optimism', 'polygon', 'baseSepolia'.

    Quick start:
        client = Synmerco()
        info = client.commerce.info()
        tx = client.commerce.encode_create_job(
            chain="base",
            provider="0x...",
            evaluator="0x...",       # must be Synmerco's hot wallet
            expired_at=int(time.time()) + 3600,
            description="Code review",
            client_did="did:key:z...",
            provider_did="did:key:z...",
        )
        # Sign tx with web3.py / eth_account / MetaMask
    """

    def __init__(self, client: 'Synmerco'):
        self._c = client

    # ---- INFO + READ ----

    def info(self) -> Dict:
        """Return supported chains, contract addresses, and fee."""
        return self._c._request("GET", "/v1/commerce/info", auth=False)

    def get_job(self, chain: str, job_id: int) -> Dict:
        """Read job state from chain."""
        return self._c._request("GET", f"/v1/commerce/jobs/{chain}/{int(job_id)}", auth=False)

    # ---- CLIENT-SIGNED ENCODERS ----

    def encode_create_job(self, chain: str, provider: str, evaluator: str,
                          expired_at: int, description: str,
                          hook: Optional[str] = None,
                          client_did: Optional[str] = None,
                          provider_did: Optional[str] = None) -> Dict:
        """Encode createJobWithDids calldata. Returns { to, data, value, chainId }."""
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/encode/createJob", body={
            "provider": provider,
            "evaluator": evaluator,
            "expiredAt": str(int(expired_at)),
            "description": description,
            "hook": hook,
            "clientDid": client_did,
            "providerDid": provider_did,
        })

    def encode_set_provider(self, chain: str, job_id: int, provider: str,
                            opt_params: Optional[str] = None) -> Dict:
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/encode/setProvider", body={
            "provider": provider, "optParams": opt_params,
        })

    def encode_set_budget(self, chain: str, job_id: int, token: str,
                          amount: int, opt_params: Optional[str] = None) -> Dict:
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/encode/setBudget", body={
            "token": token, "amount": str(int(amount)), "optParams": opt_params,
        })

    def encode_fund(self, chain: str, job_id: int, token: str,
                    expected_budget: int, opt_params: Optional[str] = None) -> Dict:
        """Returns { approve: {...}, fund: {...} } — sign approve first, then fund."""
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/encode/fund", body={
            "token": token, "expectedBudget": str(int(expected_budget)), "optParams": opt_params,
        })

    def encode_submit(self, chain: str, job_id: int, deliverable_hash: str,
                      opt_params: Optional[str] = None) -> Dict:
        """deliverable_hash must be 0x + 64 hex chars (bytes32)."""
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/encode/submit", body={
            "deliverableHash": deliverable_hash, "optParams": opt_params,
        })

    # ---- SERVER-SIGNED OPS (evaluator role) ----

    def complete(self, chain: str, job_id: int,
                 reason: Optional[str] = None,
                 opt_params: Optional[str] = None) -> Dict:
        """Server (as evaluator) calls complete(). Releases payment to provider."""
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/complete", body={
            "reason": reason, "optParams": opt_params,
        })

    def reject(self, chain: str, job_id: int,
               reason: Optional[str] = None,
               opt_params: Optional[str] = None) -> Dict:
        """Server (as evaluator) calls reject(). Refunds the client."""
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/reject", body={
            "reason": reason, "optParams": opt_params,
        })

    def claim_refund(self, chain: str, job_id: int) -> Dict:
        """Server calls claimRefund() after job expiry. Anyone can trigger."""
        return self._c._request("POST", f"/v1/commerce/jobs/{chain}/{int(job_id)}/refund")



# =========================================================================
# SMART WRAPPER — 1-call agent register + auto-listing
# =========================================================================

import secrets as _secrets
import requests as _requests
from typing import Optional as _Optional, Dict as _Dict, List as _List, Any as _Any


def register_agent_with_listing(
    base_url: str,
    *,
    label: _Optional[str] = None,
    listing_type: str = "service",
    title: str,
    description: str,
    primary_category: str,
    tags: _Optional[_List[str]] = None,
    supported_chains: _Optional[_List[str]] = None,
    max_transaction_cents: _Optional[int] = None,
    confidential_mode_default: _Optional[bool] = None,
    x25519_public_key: _Optional[str] = None,
    capabilities: _Optional[_Dict[str, bool]] = None,
    keywords: _Optional[str] = None,
    referral_code: _Optional[str] = None,
    spending_limits: _Optional[_Dict[str, int]] = None,
    timeout: float = 30.0,
) -> _Dict[str, _Any]:
    """1-call agent onboarding: generates DID + apiKey, registers with the
    escrow service, publishes the marketplace listing with all capability
    fields, and optionally links a referral code.

    Returns dict with: did, apiKey, referralCode, listingId, steps, tips,
    plus new server fields (added 2026-05-11): healthCheck (profile audit),
    agentHealthCheck (real capability verification), nextActions (4 teaching
    paths with copy-paste body examples), knowledge (URLs to llms.txt etc),
    lifecycle (7-step transaction model), agentDataCard (field guidance).

    Real-estate example with referral code:
        result = register_agent_with_listing(
            base_url="https://synmerco-escrow.onrender.com",
            label="Sarasota Realty Co",
            title="Sarasota Commercial Real Estate",
            description="Multi-family, industrial, office building specialists.",
            primary_category="Real Estate",
            max_transaction_cents=5_000_000_000,
            confidential_mode_default=True,
            capabilities={
                "confidential_capable": True,
                "fincen_reporting": True,
                "ofac_screening": True,
                "accepts_chained_escrow": True,
            },
            keywords="closing, FIRPTA, 1031-exchange",
            referral_code="SYN-AB12CD",
        )
        print(result["did"], result["apiKey"], result["referralCode"])
    """
    base_url = base_url.rstrip("/")

    did_suffix = _secrets.token_hex(16)
    did = f"did:key:z{did_suffix}"

    onboard_body: _Dict[str, _Any] = {
        "ownerDid": did,
        "label": label or "Agent",
        "description": description,
        "role": "seller" if listing_type == "service" else "buyer",
        "enableReferral": True,
        # enableWallet removed 2026-05-10 (non-custodial migration, commit 3ee1c4f).
    }
    if spending_limits:
        onboard_body["spendingLimits"] = spending_limits
    if referral_code:
        onboard_body["referralCode"] = referral_code

    r = _requests.post(f"{base_url}/v1/onboard", json=onboard_body, timeout=timeout)
    r.raise_for_status()
    onboard_data = r.json()
    api_key = onboard_data.get("apiKey")
    if not api_key:
        raise RuntimeError("Synmerco onboard succeeded but no apiKey returned")
    referral_code_out = onboard_data.get("referralCode")
    steps = onboard_data.get("steps", [])
    # New teaching/health fields (added server-side 2026-05-11)
    health_check = onboard_data.get("healthCheck")
    agent_health_check = onboard_data.get("agentHealthCheck")
    next_actions = onboard_data.get("nextActions")
    knowledge = onboard_data.get("knowledge")
    lifecycle = onboard_data.get("lifecycle")
    agent_data_card = onboard_data.get("agentDataCard")

    auth_headers = {"Authorization": f"Bearer {api_key}"}

    # Current servers link the referral code during onboarding; link here only for older servers.
    if referral_code and "referral_linked" not in steps and "referral_link_failed" not in steps:
        try:
            link_res = _requests.post(
                f"{base_url}/v1/referrals/link",
                json={"referralCode": referral_code, "referredDid": did},
                headers=auth_headers,
                timeout=timeout,
            )
            steps.append("referral_linked" if link_res.ok else "referral_link_failed")
        except Exception:
            steps.append("referral_link_failed")

    listing_id = None
    try:
        listing_body: _Dict[str, _Any] = {
            "ownerDid": did,
            "listingType": listing_type,
            "title": title,
            "description": description,
            "primaryCategory": primary_category,
        }
        if tags:
            listing_body["tags"] = tags
        if supported_chains:
            listing_body["supportedChains"] = supported_chains
        if max_transaction_cents is not None:
            listing_body["maxTransactionCents"] = max_transaction_cents
        if confidential_mode_default is not None:
            listing_body["confidentialModeDefault"] = confidential_mode_default
        if x25519_public_key:
            listing_body["x25519PublicKey"] = x25519_public_key
        if capabilities:
            listing_body["capabilities"] = capabilities
        if keywords:
            listing_body["keywords"] = keywords

        lr = _requests.post(
            f"{base_url}/v1/marketplace/listings",
            json=listing_body,
            headers=auth_headers,
            timeout=timeout,
        )
        if lr.status_code < 400:
            ld = lr.json()
            listing_id = ld.get("id") or ld.get("listingId")
            steps.append("listing_published")
    except Exception:
        pass

    return {
        "did": did,
        "apiKey": api_key,
        "referralCode": referral_code_out,
        "listingId": listing_id,
        "steps": steps,
        "tips": {
            "saveApiKey": "Store apiKey securely. Shown only once.",
            "shareReferral": (
                f"Share {referral_code_out} with other agents to earn 0.25% on Standard-tier escrows they complete."
                if referral_code_out else ""
            ),
        },
        "healthCheck": health_check,
        "agentHealthCheck": agent_health_check,
        "nextActions": next_actions,
        "knowledge": knowledge,
        "lifecycle": lifecycle,
        "agentDataCard": agent_data_card,
    }

    # Old names (before 2026-10-21): guilds are now called teams.
    def create_guild(self, name: str, capability: str) -> Dict:
        return self.create_team(name, capability)

    def join_guild(self, guild_id: str) -> Dict:
        return self.join_team(guild_id)
