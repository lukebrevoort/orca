# Orca Organization

Orca Organization is the domain that turns inbound email into a programmable, explainable attention workspace for one user across connected mail accounts.

## Mail

**Workspace**:
The user's complete Orca environment across every connected account.
_Avoid_: Tenant, inbox

**Account**:
A connected provider mailbox inside a Workspace. Account is a filterable organization facet and an authority scope.
_Avoid_: Workspace, user

**Thread**:
The conversation-level unit that Orca organizes and displays. Each Thread has exactly one primary Lane.
_Avoid_: Message, email

## Organization

**Lane**:
A user-defined primary destination for a Thread. A Lane has an identity and a default Lane Policy.
_Avoid_: Folder, mailbox, disposition

**Lane Policy**:
The default visibility, interruption, review, and retention behavior for Threads in a Lane.
_Avoid_: Lane meaning, lane name

**Fallback Lane**:
The Workspace Lane used when no higher-precedence outcome assigns a Thread elsewhere.
_Avoid_: Default inbox, uncategorized folder

**View**:
A live query that presents matching Threads without changing their primary Lane.
_Avoid_: Saved filter, virtual folder

**Collection**:
An intentionally curated set of Threads with explicit membership.
_Avoid_: View, label

**Facet**:
A typed property attached to a Thread and usable by Rules and Views.
_Avoid_: Tag, metadata field

**Context**:
A lightweight domain object, such as a project, customer, order, or application, that can be related to Threads.
_Avoid_: Collection, arbitrary database row

**Workflow State**:
The user-defined state of work for a Thread, independent of its Lane and subject matter.
_Avoid_: Lane, attention level

## Orca Language

**Event**:
An immutable fact that can begin Rule evaluation, such as a message arriving, a schedule being reached, or a user correcting a Thread.
_Avoid_: Trigger, command

**Rule**:
A stable organizational instruction with ordered immutable revisions. Its active Rule Revision selects an Event, tests a Predicate, and proposes Actions.
_Avoid_: Filter, automation script

**Rule Revision**:
An immutable, typed version of a Rule that has passed parsing and validation against a Workspace Schema revision.
_Avoid_: Rule draft, mutable rule

**Predicate**:
A pure typed expression that evaluates facts and returns true or false without changing Workspace state.
_Avoid_: Query, action

**Action**:
A typed proposal to change organization or attention state. An Action does not mutate state until it is authorized and included in an applied Change Set.
_Avoid_: Side effect, command execution

**Evaluation Context**:
The deterministic snapshot of an Event, Thread, Workspace Schema, Rule Set, and logical time used for one evaluation.
_Avoid_: Runtime globals, environment

**Rule Set**:
The active Rule Revisions evaluated for a Workspace at a specific revision.
_Avoid_: Script bundle, rule list

**Trace**:
The immutable explanation of evaluated Rules, Predicate results, proposed Actions, precedence, winners, losers, actor, and revision.
_Avoid_: Log, summary

## Change and Authority

**Organization Operation**:
One of the five semantic requests at the Organization seam: describe, query, simulate, apply, or revert.
_Avoid_: CRUD endpoint, tool action

**Change Set**:
An atomic, revision-checked set of authorized organizational changes with its Trace and risk classification.
_Avoid_: Batch request, migration

**Simulation**:
Evaluation of proposed structures and Rules against historical mail using production semantics without mutating Workspace state.
_Avoid_: Preview estimate, dry-run approximation

**Actor**:
The human, agent, or system identity responsible for an operation.
_Avoid_: User when the caller may be an agent or system

**Capability**:
A scoped permission for an Actor to inspect or change specified Workspace resources and action families.
_Avoid_: Role, access level

**Capability Snapshot**:
The immutable Capability revision evaluated for one Organization Operation and preserved in its Trace.
_Avoid_: Current role, permission lookup

**Manual Override**:
A user-selected Thread outcome that takes precedence over Rules and Lane Policy.
_Avoid_: Correction rule

**Safety Lock**:
A user-controlled constraint that prevents specified organizational changes to a Thread.
_Avoid_: Manual Override, pin
