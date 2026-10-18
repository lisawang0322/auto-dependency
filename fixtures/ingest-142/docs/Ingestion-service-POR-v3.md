<!-- PLACEHOLDER SAMPLE DATA. Written by the tool author to exercise the prototype.
     PRD R12 says the real sample POR, checklist and org map are written by someone else.
     Nothing here describes a real company, team or person. -->

# Ingestion service launch — Plan of record (v3)

Epic: INGEST-142 · Launch date: 2026-11-20 · Fix version 1.0

## 1. Overview

The ingestion service replaces the batch importer with a streaming path onto the
shared data platform. This is a new service with production database access,
backend only. Four teams are involved: the Ingestion team (service team),
Data Platform (shared platform), Security (approver) and SRE (capacity and on-call).
Go/no-go is the Friday before launch.

## 2. Deliverables

- The Ingestion team (Jira project INGEST) will have the ingestion service live in production by Nov 18.

## 3. Dependencies

- Data Platform will have the cluster quota raised for ingestion load by Nov 12.

## 4. Approvals and readiness

- Security will have the security review approved by Nov 14.
- SRE capacity and on-call will be in place the week before launch.

## 5. Assumptions

- Peak load at launch is 2× the batch importer's peak.
- No customer-facing UI changes ship with this release.
