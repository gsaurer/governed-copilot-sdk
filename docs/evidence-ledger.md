# Evidence ledger for the Copilot SDK

This proposal describes an SDK evidence ledger for recording tamper-evident execution history. The ledger is a separate SDK construct from governed sessions: governed sessions decide what can happen, while the ledger records what did happen.

## Summary

Copilot SDK applications need durable evidence of agent execution without storing sensitive prompts, tool results, credentials, or model outputs. An evidence ledger records policy-relevant metadata such as session lifecycle, tool calls, model calls, classification results, permission decisions, and policy violations.

The ledger can run locally for development and testing, or write to a remote service for enterprise deployments. The SDK should expose a common ledger interface and event schema rather than depend on a single storage product.

## Goals

- Record execution history for sessions, model calls, tool calls, permission decisions, classifications, and policy decisions.
- Store metadata and hashes instead of raw sensitive data.
- Provide tamper evidence through sequence numbers, hash chaining, signatures, and checkpoints.
- Support local and remote ledger implementations through one SDK interface.
- Use standard event and signing formats where practical.
- Integrate with observability systems without replacing them.

## Non-goals

- The ledger does not decide whether a model, tool, provider, or resource is allowed.
- A local ledger is not tamper-proof unless checkpoints are anchored outside the local host.
- The SDK does not need to own long-term compliance archive storage.
- The first version does not need first-party adapters for every enterprise logging or ledger product.

## Relationship to governed sessions

Governed sessions and the evidence ledger are separate but complementary features.

- Governed sessions apply policy profiles, restrict session capabilities, and upgrade sensitivity when trusted tools return classified data.
- The evidence ledger records policy-relevant execution facts and makes the record verifiable.

A policy feature can use the ledger as an optional or required evidence sink, but the ledger should also be useful without governed sessions. For example, an application can record tool calls and model requests for audit review even when it uses application-defined policy logic.

## Event envelope

Ledger events should use a standard event envelope where possible. CloudEvents is a good fit for event identity, type, source, time, subject, and payload because it works across local files, HTTP APIs, queues, and cloud event services.

The SDK can add ledger-specific fields inside the event `data`, including sequence number, previous hash, event hash, signature, and policy metadata.

```json
{
  "specversion": "1.0",
  "id": "01J...",
  "type": "com.github.copilot.sdk.sensitivity.upgraded",
  "source": "copilot-sdk/session/s_123",
  "subject": "session:s_123",
  "time": "2026-09-10T12:00:00Z",
  "datacontenttype": "application/json",
  "data": {
    "sequence": 42,
    "policyProfileBefore": "internal",
    "policyProfileAfter": "confidential-eu",
    "sensitivityBefore": "internal",
    "sensitivityAfter": "confidential",
    "reason": {
      "source": "tool_result",
      "toolCallId": "tc_789",
      "toolNameHash": "sha256:...",
      "classification": {
        "sensitivity": "confidential",
        "residency": "eu",
        "labels": ["customer-data"]
      }
    },
    "previousHash": "sha256:...",
    "hash": "sha256:..."
  }
}
```

## Event types

Event types should name policy-relevant facts. Use past-tense facts for completed ledger entries and split lifecycle steps when the distinction matters.

Useful event types include:

- `com.github.copilot.sdk.session.created`
- `com.github.copilot.sdk.session.resumed`
- `com.github.copilot.sdk.session.closed`
- `com.github.copilot.sdk.policy.applied`
- `com.github.copilot.sdk.policy.violation`
- `com.github.copilot.sdk.sensitivity.selected`
- `com.github.copilot.sdk.sensitivity.upgraded`
- `com.github.copilot.sdk.sensitivity.upgrade_failed`
- `com.github.copilot.sdk.tool.requested`
- `com.github.copilot.sdk.tool.allowed`
- `com.github.copilot.sdk.tool.denied`
- `com.github.copilot.sdk.tool.completed`
- `com.github.copilot.sdk.tool.result_classified`
- `com.github.copilot.sdk.model.requested`
- `com.github.copilot.sdk.model.allowed`
- `com.github.copilot.sdk.model.denied`
- `com.github.copilot.sdk.model.completed`
- `com.github.copilot.sdk.permission.requested`
- `com.github.copilot.sdk.permission.allowed`
- `com.github.copilot.sdk.permission.denied`
- `com.github.copilot.sdk.ledger.checkpointed`

## Local and remote ledgers

The SDK should expose a ledger interface rather than depend on one storage product or remote service. The same event schema can be written to a local developer ledger or sent to an enterprise evidence service.

```ts
interface EvidenceLedger {
  append(event: EvidenceEvent): Promise<EvidenceReceipt>;
  checkpoint?(): Promise<EvidenceCheckpoint>;
  verify?(range?: EvidenceRange): Promise<EvidenceVerificationResult>;
}
```

Potential implementations include:

- `LocalJsonlLedger`: writes CloudEvents to a local JSONL file with a hash chain.
- `HttpEvidenceLedger`: sends CloudEvents to a remote evidence API.
- Future OpenTelemetry exporter: exports policy evidence to an OpenTelemetry collector for SIEM integration.
- Future transparency log ledger: anchors checkpoints in a transparency log.
- Future immutable storage ledger: writes checkpoints or events to object storage with immutability controls.

The interface should allow SDK users to bring their own sink. This keeps the SDK independent from any single cloud, compliance archive, or transparency log.

## Tamper evidence

A local hash chain can provide a simple MVP:

```text
event_1_hash = sha256(canonical_json(event_1))
event_2_hash = sha256(canonical_json(event_2) + event_1_hash)
event_3_hash = sha256(canonical_json(event_3) + event_2_hash)
```

Hash chaining detects event modification, deletion, and reordering when the verifier has a trusted checkpoint. Stronger deployments can add timestamping, KMS-backed signing, and external checkpoint anchoring.

Signing can use standard formats such as JWS for JSON or COSE for CBOR. Checkpoints can be anchored in a remote transparency log, immutable object storage, or a customer compliance service.

## Relationship to observability

OpenTelemetry is complementary to this project but is documented in the upstream Copilot SDK repository. Observability is for operational visibility: traces, span correlation, exported telemetry, usage data, and debugging.

The evidence ledger has a different purpose: durable policy evidence. It records the facts an auditor or governance service needs to verify policy-relevant execution history.

The two systems should integrate without becoming the same system:

- Ledger events can carry `traceparent` and `tracestate` so auditors can correlate evidence with OpenTelemetry traces.
- Ledger sinks can export to OpenTelemetry logs when organizations want policy evidence in the same pipeline as operational telemetry.
- OpenTelemetry traces can include detailed timing and debugging context that does not belong in the ledger.
- The ledger should avoid raw prompts, raw tool results, credentials, and sensitive payloads even when telemetry capture is configured to include content.
- The ledger should provide verification metadata, such as sequence numbers, previous hashes, signatures, and checkpoints, that normal telemetry does not provide.

In short, observability answers "what happened operationally?" The evidence ledger answers "what policy-relevant decisions happened, in what order, and can the record be verified?"

## SDK surface sketch

```ts
const client = new CopilotClient({
  evidenceLedger: new LocalJsonlLedger({
    path: "./ledger.jsonl",
    signer: signingProvider,
  }),
});

const remoteLedger = new HttpEvidenceLedger({
  endpoint: "https://evidence.example.com/copilot/events",
});

const session = await client.createSession({
  evidence: "required",
});
```

```ts
interface EvidenceEvent {
  type: string;
  source: string;
  subject?: string;
  time: string;
  data: Record<string, unknown>;
}

interface EvidenceReceipt {
  eventId: string;
  sequence: number;
  hash: string;
  previousHash?: string;
  signature?: string;
  checkpointId?: string;
}
```

## MVP

The first version can focus on SDK-level recording and local verification:

1. Add an `EvidenceLedger` interface.
1. Define a CloudEvents-based evidence event schema.
1. Record session, tool, model, permission, classification, and policy events that the SDK can observe.
1. Provide a local JSONL hash-chain ledger implementation.
1. Return append receipts with sequence and hash metadata.
1. Provide a verifier for local ledgers.
1. Allow remote sinks through an HTTP ledger implementation or a user-provided `EvidenceLedger`.

## Open questions

- Which event types should be required for the MVP?
- Should the SDK provide an OpenTelemetry log exporter directly or leave that to user-provided ledger sinks?
- Which canonical JSON format should the SDK use for stable hashes across languages?
- Should signing be part of the base ledger interface or an implementation concern?
- Which remote ledger targets should have first-party adapters?
