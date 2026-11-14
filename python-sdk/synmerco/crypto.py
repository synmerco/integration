"""Synmerco confidential escrow ECIES helpers (Python).

End-to-end encryption for multi-recipient confidential escrows.
Same protocol as the TypeScript helper at @synmerco/sdk/crypto:
  - X25519 for key agreement
  - HKDF-SHA256 for key derivation
  - AES-256-GCM for both payload encryption and content-key wrapping

Requires the cryptography library:
  pip install cryptography>=42.0

Encryption method tag matches the server-side enum:
  ENCRYPTION_METHOD = "x25519-hkdf-aes256gcm"

Six functions cover the full flow:
  - generate_recipient_key_pair() -> (public_key_b64, private_key_b64)
  - generate_content_key() -> bytes (32 bytes)
  - encrypt_payload(content_key, plaintext) -> dict(ciphertext, iv)
  - decrypt_payload(content_key, ciphertext_b64, iv_b64) -> bytes
  - encrypt_content_key_for_recipient(content_key, recipient_public_key_b64) -> dict
  - decrypt_content_key_as_recipient(private_key_b64, ephemeral_public_key_b64,
                                     encrypted_content_key_b64, iv_b64) -> bytes

High-level convenience:
  - encrypt_for_multiple_recipients(plaintext, recipients) -> dict

Example - Real estate closing with 4 parties:

    from synmerco.crypto import (
        generate_recipient_key_pair,
        generate_content_key,
        encrypt_payload,
        encrypt_content_key_for_recipient,
    )

    # Each agent generates this once at registration time
    pub, priv = generate_recipient_key_pair()
    # pub goes on listing.x25519PublicKey; priv stays on-device

    # When buyer creates a confidential escrow:
    content_key = generate_content_key()
    payload = encrypt_payload(content_key, b"the closing package as JSON or PDF")

    # Wrap the content key for each recipient
    seller_envelope = encrypt_content_key_for_recipient(content_key, seller_pub)
    counsel_envelope = encrypt_content_key_for_recipient(content_key, counsel_pub)
    title_envelope = encrypt_content_key_for_recipient(content_key, title_pub)

    # Post the payload + envelopes to the escrow
    # The shared payload goes on proof_uri; each envelope hits
    # POST /v1/escrows/{id}/recipients
"""

from __future__ import annotations

import base64
import os
from typing import Any, Dict, List, Optional, Tuple

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import (
        X25519PrivateKey,
        X25519PublicKey,
    )
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
except ImportError as e:
    raise ImportError(
        "Synmerco confidential mode requires the cryptography library. "
        "Install with: pip install cryptography>=42.0"
    ) from e


# Encryption method tag - matches server-side and TypeScript SDK enum.
ENCRYPTION_METHOD = "x25519-hkdf-aes256gcm"

# Domain separation string used in HKDF info parameter.
# Binds derived keys to this specific protocol version so future
# protocol versions cannot reuse the same shared secrets.
_HKDF_INFO = b"synmerco-confidential-v1"


# ---------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------

def _b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64decode(s: str) -> bytes:
    return base64.b64decode(s)


# ---------------------------------------------------------------------
# Key generation
# ---------------------------------------------------------------------

def generate_recipient_key_pair() -> Tuple[str, str]:
    """Generate a fresh X25519 keypair for a recipient.

    Run once per agent identity. The public_key goes on the agent's
    marketplace listing as the x25519_public_key field. The private_key
    stays on-device, never leaves.

    Returns:
        Tuple of (public_key_base64, private_key_base64).
    """
    private_key = X25519PrivateKey.generate()
    public_key = private_key.public_key()

    private_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _b64encode(public_bytes), _b64encode(private_bytes)


def generate_content_key() -> bytes:
    """Generate a fresh 256-bit AES key for one confidential payload.

    Returns:
        32 bytes of cryptographically random data.
    """
    return os.urandom(32)


# ---------------------------------------------------------------------
# Payload encryption (the actual data, encrypted once per escrow)
# ---------------------------------------------------------------------

def encrypt_payload(content_key: bytes, plaintext: bytes) -> Dict[str, str]:
    """Encrypt a payload with AES-256-GCM under content_key.

    Args:
        content_key: 32 bytes from generate_content_key().
        plaintext: bytes to encrypt (str.encode() if you have a string).

    Returns:
        Dict with 'ciphertext' and 'iv' as base64 strings.
    """
    if len(content_key) != 32:
        raise ValueError(f"content_key must be 32 bytes, got {len(content_key)}")
    iv = os.urandom(12)  # 96 bits, the AES-GCM standard
    aesgcm = AESGCM(content_key)
    ciphertext = aesgcm.encrypt(iv, plaintext, associated_data=None)
    return {
        "ciphertext": _b64encode(ciphertext),
        "iv": _b64encode(iv),
    }


def decrypt_payload(content_key: bytes, ciphertext_b64: str, iv_b64: str) -> bytes:
    """Decrypt a payload with the recovered content_key.

    Args:
        content_key: 32 bytes recovered via decrypt_content_key_as_recipient().
        ciphertext_b64: base64 ciphertext from encrypt_payload().
        iv_b64: base64 IV from encrypt_payload().

    Returns:
        The original plaintext bytes.

    Raises:
        cryptography.exceptions.InvalidTag if the auth tag fails (tampering or wrong key).
    """
    if len(content_key) != 32:
        raise ValueError(f"content_key must be 32 bytes, got {len(content_key)}")
    aesgcm = AESGCM(content_key)
    return aesgcm.decrypt(_b64decode(iv_b64), _b64decode(ciphertext_b64), associated_data=None)


# ---------------------------------------------------------------------
# Content-key wrapping (envelope, one per recipient)
# ---------------------------------------------------------------------

def encrypt_content_key_for_recipient(
    content_key: bytes,
    recipient_public_key_b64: str,
) -> Dict[str, str]:
    """Wrap a content_key for one recipient using ECIES.

    Generates an ephemeral X25519 keypair (forward secrecy), does ECDH
    + HKDF-SHA256 to derive a one-time AES wrapping key, encrypts the
    content_key with AES-256-GCM under that wrapping key.

    The result is exactly the shape POST /v1/escrows/{id}/recipients
    expects.

    Args:
        content_key: 32 bytes from generate_content_key().
        recipient_public_key_b64: the recipient's static X25519 public key
            (base64), typically read from their listing.x25519_public_key.

    Returns:
        Dict with keys: ephemeralPublicKey, encryptedContentKey, iv,
        encryptionMethod. All bytes are base64-encoded.
    """
    if len(content_key) != 32:
        raise ValueError(f"content_key must be 32 bytes, got {len(content_key)}")

    # Generate ephemeral keypair for this single envelope (forward secrecy)
    ephemeral_private = X25519PrivateKey.generate()
    ephemeral_public = ephemeral_private.public_key()

    # Load recipient's static public key
    recipient_public = X25519PublicKey.from_public_bytes(
        _b64decode(recipient_public_key_b64)
    )

    # ECDH: derive shared secret
    shared_secret = ephemeral_private.exchange(recipient_public)

    # Get ephemeral public key bytes for the salt and the output
    ephemeral_public_bytes = ephemeral_public.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )

    # HKDF-SHA256: derive AES-256 wrapping key from shared secret.
    # Salt is the ephemeral public key (binds derivation to THIS message).
    # Info is the protocol-version domain separator.
    wrapping_key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=ephemeral_public_bytes,
        info=_HKDF_INFO,
    ).derive(shared_secret)

    # Encrypt content_key with AES-256-GCM under wrapping_key
    iv = os.urandom(12)
    aesgcm = AESGCM(wrapping_key)
    encrypted_content_key = aesgcm.encrypt(iv, content_key, associated_data=None)

    return {
        "ephemeralPublicKey": _b64encode(ephemeral_public_bytes),
        "encryptedContentKey": _b64encode(encrypted_content_key),
        "iv": _b64encode(iv),
        "encryptionMethod": ENCRYPTION_METHOD,
    }


def decrypt_content_key_as_recipient(
    recipient_private_key_b64: str,
    ephemeral_public_key_b64: str,
    encrypted_content_key_b64: str,
    iv_b64: str,
) -> bytes:
    """Recover a content_key from a recipient envelope.

    Inverse of encrypt_content_key_for_recipient(). Uses the recipient's
    static private key + the envelope's ephemeral public key to derive
    the same wrapping key, then decrypts the content_key.

    Args:
        recipient_private_key_b64: this agent's X25519 private key.
        ephemeral_public_key_b64: from envelope.
        encrypted_content_key_b64: from envelope.
        iv_b64: from envelope.

    Returns:
        32 bytes of content_key, ready for decrypt_payload().

    Raises:
        cryptography.exceptions.InvalidTag if the envelope was not
        wrapped for this recipient or has been tampered with.
    """
    recipient_private = X25519PrivateKey.from_private_bytes(
        _b64decode(recipient_private_key_b64)
    )
    ephemeral_public = X25519PublicKey.from_public_bytes(
        _b64decode(ephemeral_public_key_b64)
    )

    shared_secret = recipient_private.exchange(ephemeral_public)

    wrapping_key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_b64decode(ephemeral_public_key_b64),
        info=_HKDF_INFO,
    ).derive(shared_secret)

    aesgcm = AESGCM(wrapping_key)
    return aesgcm.decrypt(
        _b64decode(iv_b64),
        _b64decode(encrypted_content_key_b64),
        associated_data=None,
    )


# ---------------------------------------------------------------------
# High-level convenience
# ---------------------------------------------------------------------

def encrypt_for_multiple_recipients(
    plaintext: bytes,
    recipients: List[Dict[str, str]],
) -> Dict[str, Any]:
    """Encrypt one payload, wrap the content_key for N recipients.

    Args:
        plaintext: bytes to encrypt.
        recipients: list of dicts, each with at least 'recipientDid' and
            'publicKey' (base64 X25519 public key). Other keys are
            preserved in the output for caller convenience.

    Returns:
        Dict with:
          payload: {'ciphertext': str, 'iv': str}
          envelopes: list of dicts, each with the original recipient
                     fields PLUS the envelope fields (ephemeralPublicKey,
                     encryptedContentKey, iv, encryptionMethod).

    The 'payload' is what you POST to your storage layer (S3, IPFS, etc.)
    and reference via proof_uri. Each envelope is what you POST to
    /v1/escrows/{escrowId}/recipients for that recipient.
    """
    content_key = generate_content_key()
    payload = encrypt_payload(content_key, plaintext)

    envelopes = []
    for r in recipients:
        if "publicKey" not in r:
            raise ValueError(f"recipient missing 'publicKey' field: {r}")
        envelope = encrypt_content_key_for_recipient(content_key, r["publicKey"])
        # Merge original recipient fields with envelope fields
        envelopes.append({**r, **envelope})

    return {
        "payload": payload,
        "envelopes": envelopes,
    }


__all__ = [
    "ENCRYPTION_METHOD",
    "generate_recipient_key_pair",
    "generate_content_key",
    "encrypt_payload",
    "decrypt_payload",
    "encrypt_content_key_for_recipient",
    "decrypt_content_key_as_recipient",
    "encrypt_for_multiple_recipients",
]


# ---------------------------------------------------------------------
# Confidential escrow v2 (2026-10-29): open a sealed delivery after release
# ---------------------------------------------------------------------

def _load_private_key(private_key_b64: str) -> "X25519PrivateKey":
    """Accept the raw 32-byte key (this SDK's generate_recipient_key_pair) or PKCS#8 DER (the TypeScript SDK, the
    dashboard key file's privateKeyPkcs8 and the synmerco-sealed CLI)."""
    raw = _b64decode(private_key_b64)
    if len(raw) == 32:
        return X25519PrivateKey.from_private_bytes(raw)
    key = serialization.load_der_private_key(raw, password=None)
    if not isinstance(key, X25519PrivateKey):
        raise ValueError("private key is not an X25519 key")
    return key


def open_sealed(file_text: Any, envelope: Dict[str, str], private_key_b64: str,
                content_hash: Optional[str] = None, proof_hash: Optional[str] = None) -> str:
    """Open a sealed delivery with YOUR private key (runs locally; the key never leaves this machine).

    file_text: the sealed file (JSON {"ciphertext","iv"}) at the proof address, as bytes (preferred) or text.
    envelope: your envelope from GET /v1/escrows/<id>/recipients after release (ephemeralPublicKey,
        encryptedContentKey, iv).
    content_hash / proof_hash: when given (from GET /v1/escrows/<id>/decrypt-info), both are checked.
    Returns the plaintext as text."""
    import hashlib, json
    raw = file_text if isinstance(file_text, (bytes, bytearray)) else str(file_text).encode("utf-8")  # hash the exact bytes
    if proof_hash and hashlib.sha256(raw).hexdigest() != proof_hash.lower():
        raise ValueError("the sealed file is not the one Synmerco verified (proofHash mismatch)")
    priv = _load_private_key(private_key_b64)
    eph_bytes = _b64decode(envelope["ephemeralPublicKey"])
    shared = priv.exchange(X25519PublicKey.from_public_bytes(eph_bytes))
    wrapping_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=eph_bytes, info=_HKDF_INFO).derive(shared)
    content_key = AESGCM(wrapping_key).decrypt(_b64decode(envelope["iv"]), _b64decode(envelope["encryptedContentKey"]), None)
    payload = json.loads(raw.decode("utf-8"))
    plain = AESGCM(content_key).decrypt(_b64decode(payload["iv"]), _b64decode(payload["ciphertext"]), None)
    if content_hash and hashlib.sha256(plain).hexdigest() != content_hash.lower():
        raise ValueError("content hash mismatch")
    return plain.decode("utf-8")
