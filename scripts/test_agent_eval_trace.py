"""Trace evidence coverage, source identities and provider measurements."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from agent_eval_trace import trace_metrics


def thread(identity: str, events: list[dict]) -> dict:
    return {
        "threadId": identity,
        "events": [
            {
                "eventId": f"{identity}-{sequence}",
                "sequence": sequence,
                "recordedAt": 100 - sequence,
                "event": {"threadId": identity, "turnId": "turn", **event},
            }
            for sequence, event in enumerate(events, 1)
        ],
    }


def analyze(threads: list[dict], diagnostics: dict | None = None) -> dict:
    trace = {"formatVersion": 3, "sessionId": "session", "threads": threads}
    if diagnostics is not None:
        trace["diagnostics"] = diagnostics
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "trace.json"
        path.write_text(json.dumps(trace), encoding="utf-8")
        return trace_metrics(path)


def invocation(usage: dict | None) -> dict:
    return {
        "type": "modelInvocationRecorded",
        "record": {
            "outcome": "completed",
            "usage": usage,
            "inputEstimate": {"estimatedInputTokens": 999},
        },
    }


def accounting_fixture() -> tuple[dict, dict]:
    ledger = invocation({"inputTokens": 0, "outputTokens": 4})
    ledger["record"]["invocationId"] = "committed"
    payload = {
        "payloadId": "request",
        "kind": "coreRequest",
        "status": "saved",
        "byteLength": 2,
    }
    response = {**payload, "payloadId": "response", "kind": "modelResponse"}
    events = [
        {
            "type": "modelAttemptStarted",
            "attemptId": "attempt",
            "requestPayload": payload,
        },
        {
            "type": "modelAttemptCompleted",
            "attemptId": "attempt",
            "responsePayload": response,
        },
        {
            "type": "modelAttemptAccounted",
            "attemptId": "attempt",
            "invocationId": "committed",
            "sourceThreadSequence": 1,
        },
    ]
    return thread("root", [ledger]), {
        "formatVersion": 2,
        "recordingStatus": "recording",
        "droppedRecords": 0,
        "pendingRecords": 0,
        "events": [
            {
                "eventId": f"diagnostic-{index}",
                "sequence": index,
                "threadId": "root",
                "turnId": "turn",
                "event": event,
            }
            for index, event in enumerate(events, 1)
        ],
        "payloads": {"request": {}, "response": {}},
    }


class AgentEvalTraceTests(unittest.TestCase):
    def test_partial_usage_retains_reported_zero_and_never_uses_input_estimates(self):
        metrics = analyze(
            [
                thread(
                    "root",
                    [
                        invocation({"inputTokens": 0, "outputTokens": 4}),
                        invocation(None),
                    ],
                ),
                thread("child", [invocation({"inputTokens": 20})]),
            ]
        )
        self.assertEqual(metrics["modelCalls"], 3)
        self.assertEqual(metrics["inputTokensReported"], 20)
        self.assertEqual(metrics["usage"]["inputTokens"]["reportedCalls"], 2)
        self.assertEqual(metrics["usage"]["outputTokens"]["missingCalls"], 2)
        self.assertIsNone(metrics["usage"]["reasoningTokens"]["reported"])
        self.assertFalse(metrics["usageComplete"])
        self.assertIsNone(metrics["modelAttempts"])
        self.assertIsNone(metrics["failedAttempts"])
        empty = analyze([thread("root", [])])
        self.assertIsNone(empty["inputTokensReported"])
        self.assertFalse(empty["usageComplete"])
        zero = analyze(
            [thread("root", [invocation({"inputTokens": 0, "outputTokens": 0})])]
        )
        self.assertTrue(zero["usageComplete"])
        self.assertEqual(zero["outputTokensReported"], 0)

    def test_tool_results_use_thread_and_turn_identity_without_clock_order(self):
        call = {
            "type": "itemCompleted",
            "item": {"type": "toolCall", "toolCallId": "same", "name": "shell"},
        }
        result = {
            "type": "itemCompleted",
            "item": {"type": "toolResult", "toolCallId": "same", "isError": True},
        }
        decision = {
            "type": "modelResponseEvaluated",
            "sourceThreadSequence": 4,
            "decision": {
                "action": "fail",
                "reason": "truncatedOutput",
                "stopReason": {"type": "maxOutputTokens"},
                "messagePhases": ["commentary"],
                "toolCallCount": 0,
            },
        }
        decision["decision"]["source"] = {"eventId": "forged"}
        decision["decision"]["sourceThreadSequence"] = 999
        metrics = analyze(
            [
                thread("root", [call, result, {**call, "turnId": "second"}, decision]),
                thread(
                    "child",
                    [call, {**result, "item": {**result["item"], "isError": False}}],
                ),
            ]
        )
        self.assertEqual(metrics["toolCalls"], 3)
        self.assertEqual(metrics["toolResults"], 2)
        self.assertEqual(metrics["failedToolResults"], 1)
        self.assertEqual(metrics["pendingToolResults"], 1)
        self.assertEqual(metrics["loopReasons"], {"truncatedOutput": 1})
        self.assertEqual(
            metrics["observations"][0]["source"],
            {
                "source": "durable",
                "threadId": "root",
                "turnId": "turn",
                "eventId": "root-2",
                "sequence": 2,
            },
        )
        self.assertEqual(metrics["loopDecisions"][0]["source"]["eventId"], "root-4")
        self.assertEqual(metrics["loopDecisions"][0]["sourceThreadSequence"], 4)
        self.assertNotIn("criticalPath", metrics)
        self.assertNotIn("taskPassed", metrics)

    def test_capture_gaps_are_explicit_and_hook_runs_are_not_model_attempts(self):
        request = {
            "payloadId": "request",
            "status": "saved",
            "kind": "coreRequest",
            "byteLength": 2,
        }
        omitted = {
            "payloadId": "omitted",
            "status": "omitted",
            "kind": "partialOutput",
            "byteLength": 100,
        }
        events = [
            {
                "type": "modelAttemptStarted",
                "attemptId": "same",
                "requestPayload": request,
            },
            {
                "type": "modelAttemptFailed",
                "attemptId": "same",
                "partialOutput": omitted,
            },
            {
                "type": "modelAttemptStarted",
                "attemptId": "same",
                "requestPayload": request,
            },
            {"type": "modelAttemptCancelled", "attemptId": "same"},
            {
                "type": "modelAttemptCompleted",
                "attemptId": "orphan",
                "responsePayload": {
                    **request,
                    "payloadId": "orphan-response",
                    "kind": "modelResponse",
                },
            },
            {
                "type": "modelAttemptStarted",
                "attemptId": "open",
                "requestPayload": request,
            },
            {
                "type": "hookRunRecorded",
                "runId": "hook",
                "executionPayload": {
                    **request,
                    "payloadId": "hook",
                    "kind": "hookExecution",
                },
            },
        ]
        records = [
            {
                "eventId": f"diag-{index}",
                "sequence": index,
                "threadId": "child" if index in {3, 4} else "root",
                "turnId": None if index == 7 else "turn",
                "event": event,
            }
            for index, event in enumerate(events, 1)
        ]
        metrics = analyze(
            [thread("root", []), thread("child", [])],
            {
                "recordingStatus": "incomplete",
                "droppedRecords": 2,
                "pendingRecords": 0,
                "unlinkedAttempts": None,
                "unobservedInvocations": None,
                "events": records,
                "payloads": {
                    "hook": {"stdout": "private output"},
                    "orphan-response": {},
                },
            },
        )
        self.assertEqual(metrics["modelAttempts"], 3)
        self.assertEqual(metrics["failedAttempts"], 1)
        self.assertEqual(metrics["cancelledAttempts"], 1)
        self.assertEqual(
            metrics["evidenceCoverage"],
            {
                "droppedRecords": 2,
                "pendingRecords": 0,
                "unlinkedAttempts": None,
                "unobservedInvocations": None,
                "omittedPayloads": 1,
                "missingPayloads": 1,
                "truncatedPayloads": 0,
                "unclosedAttempts": 1,
                "orphanedAttempts": 1,
            },
        )
        self.assertFalse(metrics["diagnosticEvidenceComplete"])
        self.assertNotIn("private output", json.dumps(metrics))
        self.assertEqual(
            next(
                item
                for item in metrics["observations"]
                if item["kind"] == "modelAttemptCancelled"
            )["source"]["threadId"],
            "child",
        )

    def test_receipts_join_exact_committed_identity_and_sequence(self):
        durable, diagnostics = accounting_fixture()
        metrics = analyze([durable], diagnostics)
        self.assertTrue(metrics["usageComparisonComplete"])
        self.assertEqual(
            metrics["accountingLinks"][0]["accountingSource"]["eventId"], "root-1"
        )
        self.assertEqual(metrics["evidenceCoverage"]["unlinkedAttempts"], 0)
        changed = copy.deepcopy(diagnostics)
        changed["events"][-1]["event"]["sourceThreadSequence"] = 2
        with self.assertRaisesRegex(ValueError, "committed event"):
            analyze([durable], changed)
        changed["events"][-1]["event"]["sourceThreadSequence"] = 1
        changed["events"][-1]["threadId"] = "other"
        metrics = analyze([durable, thread("other", [])], changed)
        self.assertIsNone(metrics["accountingLinks"][0]["accountingSource"])
        self.assertFalse(metrics["usageComparisonComplete"])
        self.assertEqual(metrics["evidenceCoverage"]["unobservedInvocations"], 1)

    def test_v2_requires_pending_watermark_and_reports_unclosed_or_orphaned_evidence(
        self,
    ):
        durable, diagnostics = accounting_fixture()
        diagnostics["pendingRecords"] = 1
        self.assertFalse(analyze([durable], diagnostics)["diagnosticEvidenceComplete"])
        del diagnostics["pendingRecords"]
        with self.assertRaisesRegex(ValueError, "pending"):
            analyze([durable], diagnostics)
        diagnostics["pendingRecords"] = 0
        diagnostics["events"] = diagnostics["events"][-1:]
        metrics = analyze([durable], diagnostics)
        self.assertEqual(metrics["evidenceCoverage"]["orphanedAttempts"], 1)
        self.assertFalse(metrics["usageComparisonComplete"])

    def test_v1_never_invents_receipt_links_and_v2_rejects_duplicate_receipts(self):
        durable, diagnostics = accounting_fixture()
        diagnostics["events"].append(
            {
                **copy.deepcopy(diagnostics["events"][-1]),
                "eventId": "duplicate",
                "sequence": 4,
            }
        )
        with self.assertRaisesRegex(ValueError, "duplicate accounting"):
            analyze([durable], diagnostics)
        diagnostics["events"] = diagnostics["events"][:2]
        diagnostics["formatVersion"] = 1
        metrics = analyze([durable], diagnostics)
        self.assertEqual(metrics["accountingLinks"], [])
        self.assertIsNone(metrics["evidenceCoverage"]["unlinkedAttempts"])
        self.assertTrue(metrics["usageComplete"])
        self.assertFalse(metrics["usageComparisonComplete"])
        diagnostics["formatVersion"] = 99
        with self.assertRaisesRegex(ValueError, "unsupported diagnostic"):
            analyze([durable], diagnostics)

    def test_duplicate_receipts_are_ambiguous_even_without_the_committed_history(self):
        _, diagnostics = accounting_fixture()
        duplicate = copy.deepcopy(diagnostics["events"][-1])
        duplicate.update(eventId="duplicate", sequence=4)
        duplicate["event"]["attemptId"] = "other-attempt"
        diagnostics["events"].append(duplicate)
        with self.assertRaisesRegex(ValueError, "duplicate accounting"):
            analyze([thread("root", [])], diagnostics)

    def test_enabling_recording_after_invocations_does_not_claim_complete_coverage(
        self,
    ):
        durable, diagnostics = accounting_fixture()
        diagnostics["events"] = []
        diagnostics["payloads"] = {}
        metrics = analyze([durable], diagnostics)
        self.assertEqual(metrics["modelAttempts"], 0)
        self.assertEqual(metrics["evidenceCoverage"]["unobservedInvocations"], 1)
        self.assertFalse(metrics["diagnosticEvidenceComplete"])
        self.assertFalse(metrics["usageComparisonComplete"])

    def test_recording_enabled_does_not_hide_a_missing_exported_payload(self):
        payload = {
            "payloadId": "request",
            "status": "saved",
            "kind": "coreRequest",
            "byteLength": 2,
        }
        response = {**payload, "payloadId": "response", "kind": "modelResponse"}
        diagnostics = {
            "recordingStatus": "recording",
            "events": [
                {
                    "eventId": "start",
                    "sequence": 1,
                    "threadId": "root",
                    "turnId": "turn",
                    "event": {
                        "type": "modelAttemptStarted",
                        "attemptId": "attempt",
                        "requestPayload": payload,
                    },
                },
                {
                    "eventId": "end",
                    "sequence": 2,
                    "threadId": "root",
                    "turnId": "turn",
                    "event": {
                        "type": "modelAttemptCompleted",
                        "attemptId": "attempt",
                        "responsePayload": response,
                    },
                },
            ],
            "payloads": {"request": {}, "response": {}},
        }
        complete = analyze([thread("root", [])], diagnostics)
        self.assertTrue(complete["diagnosticEvidenceComplete"])
        self.assertEqual(complete["failedAttempts"], 0)
        diagnostics["payloads"].clear()
        missing = analyze([thread("root", [])], diagnostics)
        self.assertFalse(missing["diagnosticEvidenceComplete"])
        self.assertEqual(missing["observations"][0]["source"]["eventId"], "start")

    def test_saved_bounded_output_is_reported_as_truncated_evidence(self):
        ref = {
            "payloadId": "partial",
            "kind": "partialOutput",
            "status": "saved",
            "byteLength": 2,
        }
        metrics = analyze(
            [thread("root", [])],
            {
                "recordingStatus": "recording",
                "events": [
                    {
                        "eventId": "end",
                        "sequence": 1,
                        "threadId": "root",
                        "turnId": "turn",
                        "event": {
                            "type": "modelAttemptCancelled",
                            "attemptId": "attempt",
                            "partialOutput": ref,
                        },
                    },
                ],
                "payloads": {"partial": {"text": "bounded", "truncated": True}},
            },
        )
        self.assertEqual(metrics["evidenceCoverage"]["truncatedPayloads"], 1)
        self.assertFalse(metrics["diagnosticEvidenceComplete"])
        self.assertEqual(
            next(
                item
                for item in metrics["observations"]
                if item["kind"] == "payloadTruncated"
            )["source"]["eventId"],
            "end",
        )

    def test_complete_success_usage_does_not_cover_an_unlinked_failed_attempt(self):
        payload = {
            "payloadId": "body",
            "status": "saved",
            "kind": "coreRequest",
            "byteLength": 2,
        }
        events = [
            {
                "type": "modelAttemptStarted",
                "attemptId": "failed",
                "requestPayload": payload,
            },
            {"type": "modelAttemptFailed", "attemptId": "failed"},
            {
                "type": "modelAttemptStarted",
                "attemptId": "success",
                "requestPayload": payload,
            },
            {
                "type": "modelAttemptCompleted",
                "attemptId": "success",
                "responsePayload": payload,
            },
        ]
        metrics = analyze(
            [thread("root", [invocation({"inputTokens": 20, "outputTokens": 5})])],
            {
                "recordingStatus": "recording",
                "events": [
                    {
                        "eventId": f"attempt-{index}",
                        "sequence": index,
                        "threadId": "root",
                        "turnId": "turn",
                        "event": event,
                    }
                    for index, event in enumerate(events, 1)
                ],
                "payloads": {"body": {}},
            },
        )
        self.assertTrue(metrics["diagnosticEvidenceComplete"])
        self.assertTrue(metrics["usageComplete"])
        self.assertEqual(metrics["inputTokensReported"], 20)
        self.assertEqual(metrics["modelAttempts"], 2)
        self.assertFalse(metrics["usageComparisonComplete"])

    def test_frozen_composition_digest_changes_when_shared_guidance_changes(self):
        instructions = {
            "owner": "prompts",
            "id": "core",
            "revision": "v1",
            "body": "primary",
            "shared": [
                {"owner": "prompts", "id": "mode", "revision": "v1", "body": "first"}
            ],
        }
        changed = copy.deepcopy(instructions)
        changed["shared"][0]["body"] = "second"
        metrics = analyze(
            [
                thread(
                    "root",
                    [
                        {
                            "type": "turnAccepted",
                            "instructions": instructions,
                            "mode": "default",
                            "kind": "coding",
                            "toolProfile": {
                                "id": "tools",
                                "definitionDigest": "digest",
                            },
                        },
                        {
                            "type": "turnModeChanged",
                            "instructions": changed,
                            "mode": "plan",
                        },
                    ],
                )
            ]
        )
        selections = metrics["instructionSelections"]
        self.assertNotEqual(
            selections[0]["instructions"]["snapshotDigest"],
            selections[1]["instructions"]["snapshotDigest"],
        )
        self.assertEqual(selections[0]["toolProfile"]["definitionDigest"], "digest")
        self.assertEqual(selections[1]["source"]["sequence"], 2)
        self.assertNotIn("body", selections[0]["instructions"])

    def test_invalid_usage_and_ambiguous_local_facts_cannot_be_graded_as_valid(self):
        for value in [True, -1, 1.5, "20"]:
            with self.subTest(usage=value), self.assertRaisesRegex(ValueError, "usage"):
                analyze([thread("root", [invocation({"inputTokens": value})])])
        ambiguous = thread("root", [invocation(None), invocation(None)])
        ambiguous["events"][1]["sequence"] = 1
        with self.assertRaisesRegex(ValueError, "local sequence"):
            analyze([ambiguous])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "trace.json"
            path.write_text(
                json.dumps(
                    {
                        "formatVersion": 3,
                        "sessionId": "other",
                        "threads": [thread("root", [])],
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, "Session"):
                trace_metrics(path, {"sessionId": "session", "threadId": "root"})


if __name__ == "__main__":
    unittest.main()
