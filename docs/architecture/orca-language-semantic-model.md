# Orca Language Semantic Model

Status: initial design for review
Date: 2026-08-23

## Purpose

The Orca language lets humans and agents express dynamic email-organization behavior without granting arbitrary code execution. Source text is compiled into typed, immutable Rule Revisions. Evaluation is pure and deterministic. Effects occur only through authorized, revision-checked Change Sets.

## Semantic pipeline

```text
Source text
  → parse to syntax tree
  → resolve names against Workspace Schema
  → type-check predicates and actions
  → classify required capabilities and risk
  → produce immutable Rule Revision

Event + Thread snapshot + Workspace snapshot + active Rule Set
  → create Evaluation Context
  → evaluate matching Rules
  → produce candidate Actions and Trace
  → resolve conflicts and precedence
  → produce proposed Change Set
  → SIMULATE without mutation or APPLY through authority + revision gates
```

## Core objects

### Event

An Event is an immutable fact with a stable ID, event type, occurrence time, Workspace, optional Account, and subject references such as Message or Thread. Initial event families:

- `message.received`
- `thread.updated`
- `schedule.reached`
- `user.corrected`

User-authored Actions do not recursively emit triggerable Events in the first language version. This prevents implicit rule loops while preserving scheduled and inbound behavior.

### Rule and Rule Revision

A Rule has stable identity, name, enabled state, priority, scope, and an ordered history of immutable Rule Revisions. A Rule Revision contains:

- One Event pattern.
- One optional Predicate tree.
- An ordered list of typed Actions.
- Required Capabilities.
- Risk classification.
- Workspace Schema revision used during compilation.

Only one Rule Revision is active at a time. Editing creates a new revision; it never changes the active revision in place.

### Evaluation Context

Evaluation receives all dependencies explicitly:

- Event.
- Thread snapshot, including its Messages.
- Workspace Schema snapshot.
- Active Rule Set revision.
- Actor and granted Capabilities.
- Logical time derived from the Event or simulation clock.

Rules cannot read the filesystem, network, process environment, or ambient wall clock. The same Evaluation Context always produces the same result.

### Predicate

A Predicate is a pure typed Boolean expression. Predicate families include:

- Equality and ordering comparisons.
- String and domain matching.
- Membership and containment.
- Explicit existence checks for optional data.
- Boolean composition with `all`, `any`, and `not`.
- Quantification over bounded collections such as thread messages or attachments.
- Date and duration comparisons against logical time.

Missing optional values never equal ordinary values. A comparison against missing data returns false unless the Predicate explicitly tests `exists` or `missing`.

### Action

An Action proposes intent; it does not directly mutate state. Initial action families:

| Family | Actions | Conflict behavior |
|---|---|---|
| Primary organization | Route to Lane; set Workflow State | Exclusive slot; one winner |
| Typed knowledge | Set or unset Facet; link or unlink Context | One winner per single-value Facet; additive for multi-value Facets and links |
| Membership | Add or remove Collection membership | Compatible actions combine; explicit conflicts use precedence |
| Attention | Notify; schedule review; suppress interruption | Resolves to one effective attention policy |
| Safety | Add a user-approved retention or deletion proposal | Requires separate destructive Capability and explicit risk acknowledgement |

The initial language cannot send mail, delete provider mail, execute network requests, or run arbitrary JavaScript, Python, or shell code.

### Trace

Every evaluation returns a Trace even when no state changes. A Trace records:

- Event and Evaluation Context revisions.
- Rule Revisions considered.
- Predicate results and relevant observed values.
- Candidate Actions.
- Winning and losing Actions.
- Applied precedence reason.
- Actor, Capabilities, risk, and timing budget.

`query` exposes Trace projections for “Why is this here?” in both the UI and MCP adapter.

### Change Set

A Change Set is an atomic plan with:

- Stable ID and idempotency key.
- Actor and Capability snapshot.
- Expected Workspace and object revisions.
- Ordered resolved changes.
- Trace and risk classification.
- Inverse information required to revert.

`revert` creates a compensating Change Set. It does not erase history or pretend the original application never occurred.

## Precedence

The global precedence order is:

1. Safety Lock.
2. Manual Override.
3. Highest-priority matching Rule Revision.
4. Lane Policy.
5. Fallback Lane or Workspace fallback.

Compatible Actions from multiple matching Rules combine. Exclusive slots select one winner. Every resolution is explicit in the Trace.

## Simulation equivalence

Simulation and live evaluation use the same parser, type checker, evaluator, conflict resolver, and precedence implementation. Only the adapters differ:

- Simulation reads historical snapshots and produces an impact report.
- Apply checks current revisions and Capabilities, then commits an atomic Change Set.

A Rule cannot activate until its compiled revision and historical simulation correspond to the same Workspace Schema revision.

## Type system

Initial scalar types:

- `Text`, `Number`, `Boolean`
- `Date`, `DateTime`, `Duration`
- `EmailAddress`, `Domain`
- `AccountRef`, `ThreadRef`, `MessageRef`
- `LaneRef`, `ViewRef`, `CollectionRef`, `ContextRef<T>`
- User-defined `Enum<T>`

Type constructors:

- `Optional<T>` for missing data.
- `List<T>` for bounded collections.
- Typed Facets defined in the Workspace Schema.

Names resolve to stable IDs during compilation. Renaming a Lane, Facet, Context, or Collection does not change an already compiled Rule Revision.

## Safety invariants

- No general loops, recursion, dynamic evaluation, filesystem access, process access, or network access.
- Bounded syntax-tree size, collection scans, candidate Actions, execution time, and historical simulation volume.
- Every Action declares required Capabilities before activation.
- No partial Change Set application.
- Rule activation is revision-checked and simulation-gated.
- Destructive behavior is outside the normal organization Capability and requires a separate security gate.

## Accepted decisions before syntax design

1. `thread.updated` remains an internal reevaluation Event in version one. A future public Event must name the changed fields and the cause.
2. Rule priority is an explicit ordered position inside the Rule Set. System precedence strata remain reserved above that order.
3. Each Rule Revision has exactly one Event pattern. This is one Event **kind**, not one Event occurrence: the Rule can evaluate every matching occurrence, use many Predicates, and propose many Actions. A separate Event kind uses a separate Rule.
4. Version one supports reusable, pure, named, parameterless Predicates. It does not support general functions or recursion.
5. Lane Policy supplies default attention behavior. A Rule can propose an explicit Attention override, and the Trace identifies the winner and precedence reason.
