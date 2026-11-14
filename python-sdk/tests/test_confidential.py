"""(1.6.9) wallet signature normalising, sealed-file address handling, proof hash rules."""
import pytest
from synmerco.client import _signature_str, _sealed_path, _proof_hash, _buyer_envelope, SynmercoError


class _Signed:  # eth_account SignedMessage shape
    signature = bytes.fromhex("ab" * 65)


def test_signature_forms():
    assert _signature_str(_Signed(), "evm") == "0x" + "ab" * 65
    assert _signature_str(bytes.fromhex("cd" * 65), "evm") == "0x" + "cd" * 65
    assert _signature_str("ef" * 65, "evm") == "0x" + "ef" * 65
    assert _signature_str("0x" + "ef" * 65, "evm") == "0x" + "ef" * 65
    assert _signature_str("3vQB7B6MrGQZaxCuFg4oh", "solana") == "3vQB7B6MrGQZaxCuFg4oh"


def test_sealed_path_only_for_this_escrows_synmerco_file():
    sid = "sdl_" + "a" * 24
    own, _ = _sealed_path("https://synmerco-escrow.onrender.com/v1/escrows/esc_1/sealed-delivery/" + sid, "esc_1")
    assert own == "/v1/escrows/esc_1/sealed-delivery/" + sid
    # a look-alike host still resolves to OUR configured API (the key never goes to the look-alike)
    own2, _ = _sealed_path("https://synmerco-escrow.onrender.com.evil.tld/v1/escrows/esc_1/sealed-delivery/" + sid, "esc_1")
    assert own2 == "/v1/escrows/esc_1/sealed-delivery/" + sid
    assert _sealed_path("https://synmerco-escrow.onrender.com/v1/escrows/esc_2/sealed-delivery/" + sid, "esc_1")[0] is None
    assert _sealed_path("https://example.com/file.json", "esc_1")[0] is None


def test_proof_hash():
    h = "a" * 64
    assert _proof_hash(given="sha256:" + h.upper()) == h
    assert len(_proof_hash("text")) == 64
    with pytest.raises(SynmercoError):
        _proof_hash()
    with pytest.raises(SynmercoError):
        _proof_hash(given="sha256:xyz")


def test_buyer_envelope_prefers_buyer_role_for_latest_proof():
    info = {"buyerPublicKey": "K", "proof": {"proofHash": "P2"}}
    recs = [
        {"recipientPublicKey": "K", "encryptedContentKey": "old", "metadata": {"role": "buyer", "proofHash": "P1"}},
        {"recipientPublicKey": "K", "encryptedContentKey": "new", "metadata": {"role": "buyer", "proofHash": "P2"}},
    ]
    assert _buyer_envelope(recs, info)["encryptedContentKey"] == "new"
    assert _buyer_envelope([], info) is None
