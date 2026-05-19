# Trajectos Intelligence Model

## Purpose
This document defines the institutional architecture of the Trajectos financial intelligence platform. It is the contract for how raw events become clusters, insights, signals, rankings, and user-facing narratives.

The model is intentionally deterministic. It prioritizes traceable evidence, bounded reasoning, and reproducible scoring over speculative prediction.

## Architecture Summary
Trajectos uses a layered intelligence stack:

1. Event ingestion captures discrete market-relevant items.
2. Canonicalization normalizes duplicate or near-duplicate items.
3. Clustering groups related events into a single market episode.
4. Insight generation converts clustered evidence into structured reasoning.
5. Signal extraction derives directional factor-level market signals.
6. Regime resolution interprets the aggregate macro state.
7. Impact scoring estimates which asset classes are most affected.
8. Relevance scoring personalizes the intelligence for users and segments.
9. Ranking combines evidence, recency, impact, and confidence into ordered delivery.
10. Narrative logic preserves the evolving story of a market event over time.

The platform already contains the following core surfaces:
- event ingestion
- clustering
- event insights
- portfolio signals
- relevance scoring
- vector embeddings
- canonical events
- user feed ranking
- regime engine
- pipeline orchestration

## Source-of-Truth Tables
These tables form the current persisted intelligence graph:

- `macro_events`: raw or semi-normalized ingested event records
- `event_clusters`: grouped event episodes
- `canonical_events`: canonical cluster-level titles and summaries
- `event_insights`: structured reasoning attached to clusters
- `portfolio_signals`: directional portfolio-level signals
- `event_factor_exposures`: factor exposure outputs for a cluster
- `event_impacts`: impact narrative or downstream impact objects when present
- `event_impact_scores`: numeric impact scores by asset class
- `user_feed`: ranked insight delivery for a user
- `user_relevance_index`: user-to-insight relevance index
- `insight_tags`: text tags attached to insights
- `segment_tags`: segment-to-tag mapping for cohort relevance
- `event_timelines`: event episode timelines and milestones

## Core Definitions

### 1. Event
An event is the smallest meaningful intelligence unit in Trajectos.

An event is:
- a discrete market, macro, corporate, policy, or cross-asset occurrence
- an item that can be ingested from feeds or other sources
- a candidate for normalization, deduplication, and clustering
- a fact anchor, not an opinion anchor

An event should answer one or more of the following:
- What happened?
- When did it happen?
- Where did it happen?
- Which entities, assets, sectors, or themes are involved?
- Why is it material to markets?

Events are not yet narratives. They are evidence fragments.

Primary storage surfaces:
- `macro_events`
- `macro_events_raw`
- pipeline queue and event fingerprint tables used by ingestion

### 2. Cluster
A cluster is a grouped market episode composed of related events that describe the same underlying situation.

A cluster represents:
- deduplicated event lineage
- an evolving topic or market episode
- a shared interpretive container for canonical summary, timeline, impact, and insight generation

Clusters are the main bridge between raw ingestion and structured intelligence.

A cluster should:
- group semantically related events
- survive source-level duplication
- retain internal chronology via `event_timelines`
- support one canonical title and one canonical summary

Primary storage surfaces:
- `event_clusters`
- `canonical_events`
- `event_timelines`

### 3. Insight
An insight is a structured, evidence-backed interpretation of a cluster.

An insight should explain:
- what the cluster means
- which factors are driving the observation
- which market implications are plausible from the evidence
- how confident the system is in that reasoning

An insight is not a prediction engine output. It is a reasoned interpretation grounded in the cluster and its factor structure.

Primary storage surfaces:
- `event_insights`
- `insight_tags`

### 4. Confidence
Confidence is a measure of evidence quality, coherence, and stability.

Confidence is not the same as importance or relevance.

In Trajectos, confidence answers:
- how strongly the evidence supports the insight or signal
- how internally consistent the contributing factors are
- how reliable the directional reading appears after scoring

Confidence should be deterministic and derived from observed inputs such as:
- factor agreement
- signal agreement
- strength of exposure
- consistency across related evidence
- cluster quality and signal density

Confidence is stored on several objects and may differ by layer:
- insight confidence for cluster-level reasoning
- signal confidence for directional outputs
- relevance confidence for user matching
- impact confidence for asset-class effect estimation

### 5. Relevance
Relevance is a user- or segment-specific measure of informational fit.

Relevance answers:
- Does this insight matter to this user or cohort?
- Does it align with the user’s assets, interests, or segment profile?
- Is it likely to be actionable or worth attention for that audience?

Relevance is not market importance.

Relevance is computed by matching structured tags, assets, and user/segment profiles.

Primary storage surfaces:
- `user_relevance_index`
- `user_feed`
- `segment_insight_index`
- `segment_tags`

### 6. Importance
Importance is a platform-level measure of market significance.

Importance answers:
- How material is this item to the market?
- How broad is the exposure?
- How quickly should a user read it?
- How likely is it to affect multiple assets or regimes?

Importance is distinct from relevance:
- a low-relevance event can still be highly important
- a high-relevance item can still be low-importance

Importance is typically derived from:
- impact magnitude
- asset breadth
- regime sensitivity
- confidence
- recency
- cross-asset propagation potential

### 7. Regime
A regime is the current macro market state inferred from aggregate structured evidence.

Trajectos currently supports the following regimes:
- inflationary
- risk_off
- growth
- deflationary

A regime is a deterministic macro classifier, not a forecast.

The regime engine converts signals into a resolved macro context that downstream systems may use to frame interpretation and allocation logic.

Primary storage surface:
- regime state is derived at runtime from `event_insights.reasoning`

### 8. Narrative
A narrative is a time-evolving explanation of a market episode.

A narrative:
- starts as an event
- becomes a cluster
- accretes canonical summary and timeline milestones
- gains insight and signal structure
- changes as new evidence arrives

The narrative is the human-readable story of how the market is interpreting the event over time.

Primary storage surfaces:
- `canonical_events`
- `event_timelines`
- `event_insights`
- `insight_tags`

### 9. Signal
A signal is a directional, factor-level or asset-level market instruction derived from structured reasoning.

Signals are usually expressed as:
- BUY
- SELL
- NEUTRAL

Signals answer:
- what direction is the evidence pointing?
- which asset or factor is affected?
- how strongly is the system leaning?

Signals are inputs to regime resolution, impact scoring, and portfolio interpretation.

Primary storage surfaces:
- `portfolio_signals`
- signal objects embedded in insight reasoning

### 10. Market Impact
Market impact is the estimated downstream effect of an event or insight on asset classes, sectors, or market factors.

Market impact answers:
- which asset classes are likely to be affected?
- how large is the implied effect?
- is the effect broad, narrow, or regime-sensitive?

Market impact is created when the platform combines:
- cluster content
- factor exposures
- directional signals
- signal confidence
- regime context
- impacted asset mapping

Primary storage surfaces:
- `event_factor_exposures`
- `event_impacts`
- `event_impact_scores`

## Intelligence Hierarchy
Trajectos uses a strict hierarchy so the system stays explainable:

1. Raw event
2. Canonical event
3. Cluster
4. Timeline
5. Insight
6. Signal
7. Impact score
8. Regime
9. Relevance index
10. Ranked feed item

Each layer may add interpretation, but should not rewrite the meaning of the previous layer.

Design rule:
- lower layers provide evidence
- middle layers provide interpretation
- upper layers provide delivery and prioritization

## Scoring Philosophy
Trajectos scoring is designed to be deterministic, conservative, and audit-friendly.

### Principles
- Evidence first: every score should trace back to a real input.
- Determinism first: identical inputs must yield identical outputs.
- Monotonicity: stronger evidence should not reduce score without explicit contradiction.
- Bounded values: scores should remain normalized and comparable.
- Layer separation: confidence, relevance, importance, and impact are distinct measures.
- Explainability: every score must be reconstructible from the stored inputs.

### Scoring hierarchy
Scoring is intentionally layered:
- factor and signal extraction establish directional evidence
- impact scoring estimates market breadth and magnitude
- regime scoring resolves the macro state
- relevance scoring maps the insight to an audience
- ranking blends the above with recency and confidence for delivery

### Normalization rules
- scores should be normalized to a known range whenever possible
- thresholds should be explicit rather than learned implicitly
- tie-breaking should be deterministic
- fallback behavior should be documented and stable

### Conservative bias
When evidence is ambiguous:
- prefer neutrality over overstatement
- prefer fallback regime over forced classification
- prefer lower confidence over fabricated precision
- prefer readable summaries over exhaustive language

## Causal Reasoning Model
Trajectos uses a causal reasoning model that translates evidence into structured explanations.

The causal model should answer:
1. What happened?
2. Which factors are plausibly driving it?
3. Which assets, sectors, or macro variables are implicated?
4. What market effects are visible or likely?
5. How confident is the reasoning?

### Causal chain
The canonical chain is:

event -> cluster -> factor exposures -> signals -> impact -> regime -> narrative -> ranking

### Causality rules
- causal statements must be grounded in observed inputs
- correlation may be used as a weak indicator, but not as a prediction claim
- one event can map to multiple factors and multiple impacts
- multiple events may converge into one cluster and one narrative
- a regime is a synthesized macro explanation, not a source event

### Evidence constraints
For institutional use, causal text should:
- separate fact from inference
- identify the originating cluster or signal when possible
- avoid language that implies certainty when confidence is low
- avoid recursive reasoning loops where the output becomes the input without new evidence

### Reasoning output
Reasoning should be structured enough to support:
- automated ranking
- human review
- downstream cross-linking
- audit and replay

## Ranking Principles
Ranking determines what surfaces to a user and in what order.

Trajectos ranking is a composite of:
- relevance
- recency
- impact strength
- confidence
- factor exposure strength

### Ranking goals
- show important items first
- keep the feed fresh
- preserve user fit
- avoid burying major market shifts
- avoid overstating weak signals

### Ranking rules
- impact can override low recency when materiality is high
- recency can boost stable but timely items
- user relevance should matter, but not at the expense of major market events
- weak confidence should down-weight, not eliminate, a materially important event

### Ranking outcome
The feed should present:
- high-importance items with strong evidence first
- user-relevant items next
- lower-importance background items later

## Narrative Evolution Logic
Narratives evolve as the market story changes.

Trajectos should treat each narrative as a living object with stages:

1. Emergence
- a new event enters the system
- it is normalized and clustered
- early canonical language is generated

2. Consolidation
- multiple events support the same episode
- canonical summary stabilizes
- tags, factors, and impact scores accumulate

3. Interpretation
- insight generation attaches structured reasoning
- regime context becomes visible
- cross-links to related themes and sectors emerge

4. Expansion or Forking
- new evidence broadens the episode or reveals a sub-theme
- the narrative may branch into related clusters
- timeline entries capture the shift

5. Resolution or Persistence
- the episode either cools down or becomes part of a longer macro regime
- later events may refer back to the original narrative as precedent

### Narrative rules
- a narrative may evolve, but its history should remain auditable
- a new story should not overwrite the old one without lineage
- cluster summaries should be updated conservatively
- timeline entries should preserve sequencing, not just final state

### Narrative outputs
The platform may surface the narrative through:
- canonical titles and summaries
- event timelines
- insight text
- related stories and theme cross-links
- user feed ranking

## Intelligence Objects and Their Roles

### Raw event
Role: capture and preserve incoming evidence.

### Canonical event
Role: unify duplicate forms into one stable representation.

### Cluster
Role: contain the episode and its growth over time.

### Timeline
Role: preserve progression, milestones, and chronology.

### Insight
Role: provide structured reasoning and market interpretation.

### Signal
Role: express the directional consequence of the evidence.

### Impact score
Role: estimate the magnitude of market effect by asset class.

### Regime
Role: summarize the macro environment implied by the evidence.

### Relevance index
Role: personalize the intelligence to a user or segment.

### Ranked feed item
Role: deliver the right intelligence in the right order.

## Table-to-Concept Mapping

- `macro_events`: raw event intake
- `canonical_events`: canonical event identity
- `event_clusters`: cluster identity and grouping
- `event_timelines`: narrative progression
- `event_insights`: structured interpretation
- `portfolio_signals`: directional market signals
- `event_factor_exposures`: factor-level causal inputs
- `event_impacts`: downstream impact artifacts
- `event_impact_scores`: quantified impact by asset class
- `insight_tags`: explanation and thematic tagging
- `asset_tags`: asset-to-theme vocabulary
- `segment_tags`: cohort-to-theme vocabulary
- `user_relevance_index`: user-specific matching
- `segment_insight_index`: segment-specific matching
- `user_feed`: ranked delivery for a user

## Operating Constraints

### Deterministic behavior
The intelligence model must remain deterministic wherever possible.
If the same cluster, signals, and inputs are replayed, the outputs should be stable.

### Isolation boundaries
- the feed layer must not trigger allocation changes
- regime inference must remain independent of feed presentation
- narrative rendering must not rewrite source evidence
- ranking may consume outputs, but should not mutate upstream tables

### Auditability
Every material output should be traceable back to source tables or deterministic transformations.

### Performance
The platform should favor precomputed and incremental outputs over heavy runtime recomputation.

## Practical Interpretation of the Model
If an operator asks, “What does Trajectos believe is happening?” the answer should flow through this hierarchy:

1. What happened at the event level?
2. What cluster does it belong to?
3. What canonical story is emerging?
4. What insight does the cluster support?
5. What factor and asset signals were derived?
6. What impact scores were assigned?
7. What regime, if any, is implied?
8. How relevant is it to the user or segment?
9. How should it be ranked in the feed?

That is the core institutional contract for Trajectos intelligence.

