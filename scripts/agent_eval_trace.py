"""Read-only evaluation evidence from exported rollout traces; never task acceptance."""

from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path


TOKEN_FIELDS = (
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningTokens",
)
PAYLOAD_FIELDS = (
    "requestPayload",
    "responsePayload",
    "partialOutput",
    "executionPayload",
)
ATTEMPT_ENDS = {
    "modelAttemptCompleted",
    "modelAttemptFailed",
    "modelAttemptCancelled",
    "modelAttemptAbandoned",
}


def _object(value: object, label: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"invalid {label}")
    return value


def _reference(record: dict, thread_id: str, source: str) -> dict:
    event = record["event"]
    item = _object(event.get("item"), "trace item")
    turn_id = (
        record.get("turnId")
        if source == "diagnostic"
        else event.get("turnId") or item.get("turnId")
    )
    if turn_id is not None and not isinstance(turn_id, str):
        raise ValueError("invalid trace Turn identity")
    return {
        "source": source,
        "threadId": thread_id,
        "turnId": turn_id,
        "eventId": record["eventId"],
        "sequence": record["sequence"],
    }


def _records(records: list, thread_id: str | None = None) -> list[tuple[dict, dict]]:
    if not isinstance(records, list):
        raise ValueError("trace events must be a list")
    previous = 0
    identities: set[str] = set()
    result = []
    for record in records:
        if (
            not isinstance(record, dict)
            or type(record.get("sequence")) is not int
            or record["sequence"] <= previous
            or not isinstance(record.get("eventId"), str)
            or not record["eventId"]
            or record["eventId"] in identities
            or not isinstance(record.get("event"), dict)
            or not isinstance(record["event"].get("type"), str)
        ):
            raise ValueError("trace event identities and local sequence must be valid")
        event = record["event"]
        owner = thread_id if thread_id is not None else record.get("threadId")
        if not isinstance(owner, str) or not owner:
            raise ValueError("trace event must identify its Thread")
        if event.get("threadId", owner) != owner:
            raise ValueError("trace event belongs to another Thread")
        previous = record["sequence"]
        identities.add(record["eventId"])
        result.append(
            (event, _reference(record, owner, "durable" if thread_id else "diagnostic"))
        )
    return result


def trace_metrics(path: Path, outcome: dict | None = None) -> dict:
    """Summarize retained facts with source identities and explicit evidence gaps.

    Attempts are semantic ModelService operations, not HTTP retries. Token subtotals
    contain provider reports only; an absent measurement is null, including zero calls.
    Recorded usage completeness is distinct from comparable execution usage. Version 2
    links attempts only through committed accounting receipts; missing links stay unknown.
    No ordering, critical path, task grade or cause is inferred across Threads.
    """
    if not path.is_file():
        return {"captureStatus": "missing"}
    trace = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(trace, dict)
        or trace.get("formatVersion") != 3
        or not isinstance(trace.get("threads"), list)
        or not isinstance(trace.get("sessionId"), str)
        or not trace["sessionId"]
    ):
        raise ValueError("invalid rollout trace")
    if outcome and outcome.get("sessionId") != trace["sessionId"]:
        raise ValueError("trace Session differs from the execution outcome")
    durable = []
    thread_ids: set[str] = set()
    for thread in trace["threads"]:
        identity = thread["threadId"]
        if not isinstance(identity, str) or not identity or identity in thread_ids:
            raise ValueError("trace Thread identities must be unique")
        thread_ids.add(identity)
        durable.extend(_records(thread["events"], identity))
    if outcome and outcome.get("threadId") not in thread_ids:
        raise ValueError("trace does not contain the execution Thread")
    if outcome and not any(
        ref["threadId"] == outcome.get("threadId")
        and ref["turnId"] == outcome.get("turnId")
        for _, ref in durable
    ):
        raise ValueError("trace does not contain the execution Turn")

    invocations = []
    invocation_sources = {}
    tools: dict[tuple, dict] = {}
    results: dict[tuple, dict] = {}
    decisions = []
    selections = []
    observations = []
    for event, ref in durable:
        kind = event["type"]
        item = _object(event.get("item"), "trace item")
        if kind == "modelInvocationRecorded":
            invocation = event["record"]
            if not isinstance(invocation, dict) or invocation.get("outcome") not in {
                "completed",
                "failed",
                "cancelled",
            }:
                raise ValueError("invalid model invocation outcome")
            invocation = _object(invocation, "model invocation")
            invocation_usage = _object(
                invocation.get("usage"), "model invocation usage"
            )
            invocations.append(invocation)
            identity = invocation.get("invocationId")
            if identity is not None:
                if not isinstance(identity, str) or not identity:
                    raise ValueError("invalid accounting invocation identity")
                key = (ref["threadId"], ref["turnId"], identity)
                if key in invocation_sources:
                    raise ValueError("duplicate accounting invocation identity")
                invocation_sources[key] = ref
            if invocation.get("outcome") in {"failed", "cancelled"}:
                observations.append(
                    {
                        "kind": "modelInvocationNotCompleted",
                        "outcome": invocation["outcome"],
                        "source": ref,
                    }
                )
            missing_usage = [
                field
                for field in ("inputTokens", "outputTokens")
                if invocation_usage.get(field) is None
            ]
            if missing_usage:
                observations.append(
                    {"kind": "usageMissing", "dimensions": missing_usage, "source": ref}
                )
        elif kind == "itemCompleted" and item.get("type") in {
            "toolCall",
            "toolResult",
        }:
            key = (ref["threadId"], ref["turnId"], item["toolCallId"])
            collection = tools if item["type"] == "toolCall" else results
            if key in collection:
                raise ValueError("duplicate tool fact in one Thread Turn")
            collection[key] = {"item": item, "source": ref}
            if item["type"] == "toolResult" and type(item.get("isError")) is not bool:
                raise ValueError("invalid tool result outcome")
            if item["type"] == "toolResult" and item.get("isError") is True:
                observations.append(
                    {
                        "kind": "toolResultError",
                        "toolCallId": item["toolCallId"],
                        "source": ref,
                    }
                )
        elif kind == "modelResponseEvaluated":
            decision = event["decision"]
            if not isinstance(decision, dict):
                raise ValueError("invalid loop decision")
            decisions.append(
                {
                    **decision,
                    "source": ref,
                    "sourceThreadSequence": event["sourceThreadSequence"],
                }
            )
            if decision["action"] in {"fail", "superseded"}:
                observations.append(
                    {
                        "kind": "loopStopped",
                        "action": decision["action"],
                        "reason": decision["reason"],
                        "source": ref,
                    }
                )
        elif kind in {"turnAccepted", "turnModeChanged"}:
            instructions = event.get("instructions")
            snapshot = None
            if instructions is not None:
                if not isinstance(instructions, dict):
                    raise ValueError("invalid frozen instructions")
                # Hash the full frozen composition, not merely its primary body or revision.
                snapshot = {
                    "owner": instructions["owner"],
                    "id": instructions["id"],
                    "revision": instructions["revision"],
                    "snapshotDigest": hashlib.sha256(
                        json.dumps(
                            instructions,
                            sort_keys=True,
                            separators=(",", ":"),
                            ensure_ascii=False,
                        ).encode()
                    ).hexdigest(),
                }
            selections.append(
                {
                    "source": ref,
                    "instructions": snapshot,
                    **{
                        key: event.get(key)
                        for key in (
                            "kind",
                            "mode",
                            "model",
                            "reasoningEffort",
                            "toolProfile",
                        )
                    },
                }
            )

    usage = {}
    for field in TOKEN_FIELDS:
        reported = []
        for invocation in invocations:
            value = _object(invocation.get("usage"), "model invocation usage").get(
                field
            )
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError(f"invalid provider usage: {field}")
            if value is not None:
                reported.append(value)
        usage[field] = {
            "reported": sum(reported) if reported else None,
            "reportedCalls": len(reported),
            "missingCalls": len(invocations) - len(reported),
            "complete": bool(invocations) and len(reported) == len(invocations),
        }

    diagnostics = _object(trace.get("diagnostics"), "trace diagnostics")
    diagnostic_version = diagnostics.get("formatVersion", 1)
    if type(diagnostic_version) is not int or diagnostic_version not in {1, 2}:
        raise ValueError("unsupported diagnostic trace version")
    pending = diagnostics.get("pendingRecords", 0 if diagnostic_version == 1 else None)
    if type(pending) is not int or pending < 0:
        raise ValueError("invalid pending diagnostic record count")
    status = diagnostics.get("recordingStatus", "disabled")
    if status not in {"disabled", "recording", "incomplete", "unavailable"}:
        raise ValueError("invalid diagnostic recording status")
    diagnostic_records = _records(diagnostics.get("events", []))
    payloads = diagnostics.get("payloads", {})
    if not isinstance(payloads, dict):
        raise ValueError("invalid diagnostic payloads")
    attempts: dict[tuple, set[str]] = {}
    payload_refs: dict[str, dict] = {}
    truncated = 0
    accounting_links = {}
    receipt_invocations = set()
    linked_invocations = set()
    for event, ref in diagnostic_records:
        kind = event["type"]
        if kind == "modelAttemptAccounted":
            if diagnostic_version != 2:
                raise ValueError("accounting links require diagnostic trace version 2")
            identity = event.get("invocationId")
            attempt_id = event.get("attemptId")
            sequence = event.get("sourceThreadSequence")
            if (
                not isinstance(identity, str)
                or not identity
                or not isinstance(attempt_id, str)
                or not attempt_id
                or type(sequence) is not int
                or sequence <= 0
            ):
                raise ValueError("invalid accounting receipt")
            key = (ref["threadId"], ref["turnId"], attempt_id)
            invocation_key = (ref["threadId"], ref["turnId"], identity)
            if key in accounting_links or invocation_key in receipt_invocations:
                raise ValueError("duplicate accounting receipt")
            receipt_invocations.add(invocation_key)
            source = invocation_sources.get(invocation_key)
            if source and source["sequence"] != sequence:
                raise ValueError("accounting receipt differs from its committed event")
            accounting_links[key] = {
                "invocationId": identity,
                "source": ref,
                "accountingSource": source,
            }
            if source:
                linked_invocations.add(invocation_key)
            else:
                observations.append({"kind": "accountingLinkMissing", "source": ref})
        required_payload = (
            "responsePayload"
            if kind == "modelAttemptCompleted"
            else "requestPayload"
            if kind in {"modelAttemptStarted", "modelRequestPrepared"}
            else None
        )
        if required_payload and event.get(required_payload) is None:
            raise ValueError(
                "model observation is missing its required payload reference"
            )
        if (
            kind in {"modelAttemptStarted", "modelRequestPrepared"}
            or kind in ATTEMPT_ENDS
        ):
            key = (ref["threadId"], ref["turnId"], event["attemptId"])
            kinds = attempts.setdefault(key, set())
            if kind in kinds or (kind in ATTEMPT_ENDS and kinds & ATTEMPT_ENDS):
                raise ValueError("duplicate or conflicting model attempt lifecycle")
            kinds.add(kind)
            if kind in ATTEMPT_ENDS - {"modelAttemptCompleted"}:
                observations.append(
                    {"kind": kind, "attemptId": event["attemptId"], "source": ref}
                )
        for field in PAYLOAD_FIELDS:
            payload = event.get(field)
            if payload is not None:
                if not isinstance(payload, dict) or payload.get("status") not in {
                    "saved",
                    "omitted",
                }:
                    raise ValueError("invalid diagnostic payload reference")
                identity = payload["payloadId"]
                if not isinstance(identity, str) or not identity:
                    raise ValueError("invalid diagnostic payload identity")
                if identity in payload_refs and payload_refs[identity] != payload:
                    raise ValueError("conflicting diagnostic payload references")
                if identity not in payload_refs:
                    payload_refs[identity] = payload
                    body = payloads.get(identity)
                    if isinstance(body, dict) and any(
                        body.get(key) is True
                        for key in ("truncated", "stdoutTruncated", "stderrTruncated")
                    ):
                        truncated += 1
                        observations.append(
                            {
                                "kind": "payloadTruncated",
                                "payloadId": identity,
                                "source": ref,
                            }
                        )
                    if payload["status"] == "omitted" or identity not in payloads:
                        observations.append(
                            {
                                "kind": "payloadOmitted"
                                if payload["status"] == "omitted"
                                else "payloadMissing",
                                "payloadId": identity,
                                "source": ref,
                            }
                        )
    omitted = sum(ref["status"] == "omitted" for ref in payload_refs.values())
    missing = sum(
        ref["status"] == "saved" and identity not in payloads
        for identity, ref in payload_refs.items()
    )
    unclosed = sum(
        "modelAttemptStarted" in kinds and not kinds & ATTEMPT_ENDS
        for kinds in attempts.values()
    )
    orphaned = sum("modelAttemptStarted" not in kinds for kinds in attempts.values())
    orphaned += sum(key not in attempts for key in accounting_links)
    dropped = diagnostics.get("droppedRecords", 0)
    if type(dropped) is not int or dropped < 0:
        raise ValueError("invalid dropped diagnostic record count")
    unlinked_attempts = (
        sum(
            key not in accounting_links
            or accounting_links[key]["accountingSource"] is None
            for key, kinds in attempts.items()
            if "modelAttemptStarted" in kinds
        )
        if diagnostic_version == 2
        else None
    )
    unobserved_invocations = (
        len(invocations) - len(linked_invocations) if diagnostic_version == 2 else None
    )
    enabled = status in {"recording", "incomplete"} or bool(attempts)
    complete = status == "recording" and not any(
        (
            dropped,
            pending,
            omitted,
            missing,
            truncated,
            unclosed,
            orphaned,
            unobserved_invocations,
            any(link["accountingSource"] is None for link in accounting_links.values()),
        )
    )
    usage_comparable = (
        complete
        and diagnostic_version == 2
        and unlinked_attempts == 0
        and unobserved_invocations == 0
        and not any(
            kinds & (ATTEMPT_ENDS - {"modelAttemptCompleted"})
            for kinds in attempts.values()
        )
    )
    return {
        "analysisVersion": 2,
        "captureStatus": "saved",
        "sessionId": trace["sessionId"],
        "threads": len(thread_ids),
        "modelCalls": len(invocations),
        "failedModelCalls": sum(
            record.get("outcome") == "failed" for record in invocations
        ),
        "modelAttempts": sum(
            "modelAttemptStarted" in kinds for kinds in attempts.values()
        )
        if enabled
        else None,
        "failedAttempts": sum(
            "modelAttemptFailed" in kinds for kinds in attempts.values()
        )
        if enabled
        else None,
        "cancelledAttempts": sum(
            "modelAttemptCancelled" in kinds for kinds in attempts.values()
        )
        if enabled
        else None,
        "abandonedAttempts": sum(
            "modelAttemptAbandoned" in kinds for kinds in attempts.values()
        )
        if enabled
        else None,
        "diagnosticRecordingStatus": status,
        "diagnosticEvidenceComplete": complete,
        "savedPayloads": len(payloads),
        "accountingLinks": list(accounting_links.values()),
        "evidenceCoverage": {
            "droppedRecords": dropped,
            "pendingRecords": pending,
            "unlinkedAttempts": unlinked_attempts,
            "unobservedInvocations": unobserved_invocations,
            "omittedPayloads": omitted,
            "missingPayloads": missing,
            "truncatedPayloads": truncated,
            "unclosedAttempts": unclosed,
            "orphanedAttempts": orphaned,
        },
        "usage": usage,
        "inputTokensReported": usage["inputTokens"]["reported"],
        "outputTokensReported": usage["outputTokens"]["reported"],
        "usageComplete": usage["inputTokens"]["complete"]
        and usage["outputTokens"]["complete"],
        "usageComparisonComplete": usage_comparable,
        "toolCalls": len(tools),
        "toolResults": len(results),
        "failedToolResults": sum(
            result["item"].get("isError") is True for result in results.values()
        ),
        "pendingToolResults": len(tools.keys() - results.keys()),
        "unmatchedToolResults": len(results.keys() - tools.keys()),
        "loopActions": dict(Counter(decision["action"] for decision in decisions)),
        "loopReasons": dict(Counter(decision["reason"] for decision in decisions)),
        "loopDecisionEvidence": "saved" if decisions else "unavailable",
        "loopDecisions": decisions,
        "instructionSelections": selections,
        "observations": observations,
        "graphWarnings": _object(trace.get("graph"), "trace graph").get("warnings", []),
    }
