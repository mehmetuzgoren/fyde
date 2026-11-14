from __future__ import annotations

from typing import Literal

from .embedder import MultimodalEmbedder, cosine_similarity
from .models import ContactPermission, IndexedAsset, SmartScopeRule


AccessDecision = Literal["allow_trusted", "allow_smart_scope", "ask_owner", "deny"]


def asset_matches_smart_scope(
    asset: IndexedAsset,
    rule: SmartScopeRule,
    embedder: MultimodalEmbedder,
) -> bool:
    asset_tags_lower = {t.lower() for t in asset.tags}
    for excl in rule.excluded_tags:
        if excl.lower() in asset_tags_lower:
            return False

    if rule.media_types and asset.media_type not in rule.media_types:
        return False

    searchable_meta = " ".join(
        [
            asset.location,
            asset.title,
            asset.filename,
            asset.summary,
            asset.folder_path,
            " ".join(asset.tags),
        ]
    ).lower()

    if rule.locations:
        loc_ok = any(loc.lower() in searchable_meta for loc in rule.locations)
        if not loc_ok:
            return False

    if rule.people:
        people_lower = {p.lower() for p in asset.people}
        for required_person in rule.people:
            rp = required_person.lower()
            if rp not in people_lower and rp not in searchable_meta:
                return False

    if rule.date_from and asset.created_at[:10] < rule.date_from[:10]:
        return False
    if rule.date_to and asset.created_at[:10] > rule.date_to[:10]:
        return False

    if rule.semantic_query and rule.semantic_query.strip():
        q = rule.semantic_query.strip()
        q_words = [w for w in q.lower().split() if len(w) > 2]
        lexical_hit = bool(q_words) and all(w in searchable_meta for w in q_words)
        if not lexical_hit:
            q_vec = embedder.embed_query(q)
            sim = cosine_similarity(q_vec, asset.embedding)
            if sim < rule.similarity_threshold:
                return False

    return True


def evaluate_asset_permission(
    asset: IndexedAsset,
    permission: ContactPermission | None,
    embedder: MultimodalEmbedder,
) -> AccessDecision:
    """
    Determines whether a contact may automatically retrieve `asset`, must trigger
    an `ask_owner` approval request, or is denied outright (e.g. private vault tag).
    """
    asset_tags_lower = {t.lower() for t in asset.tags}
    if "private" in asset_tags_lower or "hidden" in asset_tags_lower or "vault" in asset_tags_lower:
        return "deny"

    if permission is None:
        return "ask_owner"

    for excl in permission.excluded_tags:
        if excl.lower() in asset_tags_lower:
            return "deny"

    if permission.tier == "trusted":
        return "allow_trusted"

    if permission.tier == "smart_scope":
        for rule in permission.smart_scopes:
            if asset_matches_smart_scope(asset, rule, embedder):
                return "allow_smart_scope"
        # Outside their smart scope -> route as an Ask-First approval request to owner
        return "ask_owner"

    if permission.tier in ("ask_first", "send_only"):
        return "ask_owner"

    return "deny"
