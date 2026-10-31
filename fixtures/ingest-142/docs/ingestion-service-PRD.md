<!-- PLACEHOLDER SAMPLE DATA. Written by the tool author to exercise the early-stage path (PRD R17, R18).
     PRD R12 says the real sample documents are written by someone else. Nothing here describes a real
     company, team or person. The same text is exported as ingestion-service-PRD.docx by
     fixtures/build_docx.py. -->

# Ingestion service — PRD

Owner: Priya Natarajan (TPM) · Status: draft v2 · No team assigned yet · Jira epic INGEST-142 created at kickoff

## 1. Goals

Replace the batch importer with a streaming ingestion path so that customer events are available on
the shared data platform within a minute of arriving. Generally available to enterprise customers in Q4.

## 2. Scope

Partners send events through a new public API, authenticated per tenant. The existing batch importer
stays available for one quarter behind a compatibility shim. No billing changes.

## 3. Data

Stores raw customer event data for 90 days so failed events can be replayed. Replayed events are
deduplicated by event id. Aggregates are kept indefinitely.

## 4. Users

Support agents get a dashboard to find and replay failed events. Tenant admins see ingestion status
on their existing settings page.

## 5. Requirements

Must handle 2× today's peak traffic at launch without dropping events. Latency from arrival to
availability under 60 seconds at the 95th percentile. Per-tenant rate limits are configurable.

## 6. Open questions

Which partners join the first beta? Does the compatibility shim need its own deprecation notice?
