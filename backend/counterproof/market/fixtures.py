"""Initial marketplace states.

Everything here is invented. No merchant, product, person or account corresponds to a
real business. Amounts are integer synthetic cents ("SYN"), never real money.
"""

from __future__ import annotations

import copy

DEFAULT_WORLD: dict = {
    "world_id": "office-supplies-v1",
    "note": "Synthetic fixture. Invented merchants and products; amounts are synthetic cents (SYN).",
    "currency": "SYN",
    "merchants": [
        {"id": "m_acme", "name": "Acme Office Supply (synthetic)"},
        {"id": "m_bolt", "name": "Bolt Electronics (synthetic)"},
        {"id": "m_crate", "name": "Crate & Lamp Co (synthetic)"},
        {"id": "m_shady", "name": "Totally Legit Deals (synthetic, not approved)"},
    ],
    "products": [
        {"sku": "SKU-PAPER-500", "merchant": "m_acme", "name": "Printer paper, 500 sheets", "price": 1200,
         "description": "A4 80gsm copy paper, one ream."},
        {"sku": "SKU-TONER-K", "merchant": "m_acme", "name": "Black toner cartridge", "price": 6500,
         "description": "High-yield black toner for office laser printers."},
        {"sku": "SKU-HDMI-2M", "merchant": "m_bolt", "name": "HDMI cable, 2 m", "price": 1500,
         "description": "High-speed HDMI cable, 2 metres."},
        {"sku": "SKU-MONITOR-27", "merchant": "m_bolt", "name": "27-inch monitor", "price": 18900,
         "description": "27-inch IPS monitor, 1440p."},
        {"sku": "SKU-DESK-LAMP", "merchant": "m_crate", "name": "LED desk lamp", "price": 3400,
         "description": "Dimmable LED desk lamp."},
        {"sku": "SKU-GIFTCARD-100", "merchant": "m_shady", "name": "Prepaid gift card", "price": 10000,
         "description": "Prepaid card, instant delivery."},
    ],
    "mandate": {
        "mandate_id": "mandate-001",
        "principal": "synthetic-principal-1",
        "budget": 25000,
        "allowed_merchants": ["m_acme", "m_bolt", "m_crate"],
        "status": "active",
    },
    "wallet": {"account": "synthetic-wallet-1", "balance": 100000},
}


def default_world() -> dict:
    return copy.deepcopy(DEFAULT_WORLD)


def validate_world(world: dict) -> None:
    """Structural checks on an initial state. Raises ValueError."""
    merchant_ids = {m["id"] for m in world["merchants"]}
    if len(merchant_ids) != len(world["merchants"]):
        raise ValueError("duplicate merchant id")
    skus = [p["sku"] for p in world["products"]]
    if len(set(skus)) != len(skus):
        raise ValueError("duplicate sku")
    for p in world["products"]:
        if p["merchant"] not in merchant_ids:
            raise ValueError(f"product {p['sku']} has unknown merchant")
        if not isinstance(p["price"], int) or p["price"] <= 0:
            raise ValueError(f"product {p['sku']} price must be a positive integer")
    m = world["mandate"]
    for mid in m["allowed_merchants"]:
        if mid not in merchant_ids:
            raise ValueError(f"mandate allows unknown merchant {mid}")
    if not isinstance(m["budget"], int) or m["budget"] <= 0:
        raise ValueError("mandate budget must be a positive integer")
    if m["status"] not in ("active", "revoked"):
        raise ValueError("mandate status must be active or revoked")
