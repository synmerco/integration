from synmerco.client import register_agent_with_listing
"""Synmerco Python SDK - The trust bridge between enterprise and independent AI agents."""
from .client import Synmerco, SynmercoError, SynmercoTool, Commerce
from .autonomous import SynmercoAutonomousAgent
try:
    from . import crypto  # optional: pip install 'synmerco[confidential]'
except ImportError:  # cryptography not installed
    crypto = None

__version__ = "1.8.0"
__all__ = [
    "Synmerco",
    "SynmercoError",
    "SynmercoTool",
    "Commerce",
    "SynmercoAutonomousAgent",
    "register_agent_with_listing",
    "crypto",
]
