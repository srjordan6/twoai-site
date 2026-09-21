# theworldofai.org: Architecture on the PC and Cloudflare

**Version 2.1 · 2026-09-21 · Supersedes the Build Blueprint of 2026-08-01**

Version 2.1 adds section 10, the changes of 21 September 2026, and corrects the Ask box model in section 3.3. Sections 1 to 9 otherwise describe the 5 September cutover as measured that day.

The August blueprint described a system hosted on Render. On 5 September 2026 the database, the pipeline and the MCP layer moved to Stephen's PC, with Cloudflare in front. This document describes what exists now, in enough detail to rebuild it from a bare machine, and states which parts are load-bearing and which are conveniences.

Nothing here is aspirational. Every number was measured on 2026-09-05.

---

## 1. The shape of it

```
   internet sources                    Stephen's PC (Windows 11, 4 TB NVMe)
   LegiScan, CourtListener,          ┌────────────────────────────────────┐
   OpenAlex, SEC, USPTO,   ───────►  │  pipeline.exe   (Go, 78 files,     │
   OpenStreetMap, EIA,               │                  34,012 lines)     │
   the ISOs, 28 vendor feeds,        │        │                           │
   Anthropic, Hugging Face           │        ▼                           │
                                     │  PostgreSQL 18.6                   │
                                     │  srj_audit · 6.3 GB · 201 tables   │
                                     │  8 views · 48 ledger triggers      │
                                     └──────────┬─────────────────────────┘
                                                │ cloudflared, 4 QUIC conns
                                                │ outbound only, no open ports
                                     ┌──────────▼─────────────────────────┐
                                     │  Cloudflare                        │
   readers ◄──── theworldofai.org ◄──┤  Workers, Hyperdrive, Vectorize,   │
   Claude   ◄──── srj-mcp Worker  ◄──┤  Workers AI, R2, D1, Pages assets  │
                                     └────────────────────────────────────┘
                                                │
                                     ┌──────────▼─────────────────────────┐
                                     │  SRJNAS (QNAP TS-431X3, 9 TB)      │
                                     │  dumps 4×/day · WAL · Veeam · base │
                                     │           │                        │
                                     │           ▼ nightly                 │
                                     │       OneDrive (off-site)          │
                                     └────────────────────────────────────┘
```

**The load-bearing claim:** the PC holds the only live copy of the database. Cloudflare serves static pages that survive the PC being off; the Ask box and the MCP do not.

---

## 2. The PC

### 2.1 Machine and power

Windows 11, 4 TB NVMe, 2.5 GbE. **Sleep and hibernation are disabled** — `powercfg /change standby-timeout-ac 0`, `hibernate-timeout-ac 0`, `powercfg /hibernate off`, monitor off at 15 minutes. This is not a preference. The machine holds a tunnel that Cloudflare Workers read through; S0 Modern Standby on this hardware reports *Network Disconnected*, so a sleeping PC is a dead Ask box.

Verify: `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` must show `0x00000000`.

### 2.2 PostgreSQL

| | |
|---|---|
| Version | 18.6, x86_64-windows, msvc |
| Service | `postgresql-x64-18`, runs as `NT AUTHORITY\NetworkService` |
| Database | `srj_audit`, 6.3 GB |
| Listen | `127.0.0.1` only. **Never bind 0.0.0.0.** The tunnel is the only ingress |
| Objects | 201 tables, 8 views, 48 ledger triggers |

**Roles:**

| Role | Rights | Used by |
|---|---|---|
| `postgres` | superuser | local administration, dumps |
| `twoai_reader` | SELECT on all tables in `public` and `pipeline`, plus default privileges for future tables | Ask box, MCP reads |
| `srj_mcp` | full write on `public` and `pipeline`, plus default privileges | MCP writes only |

The default-privileges grants matter: without them a table created by a future pipeline stage is invisible to the Ask box until someone notices. That gap existed on 5 September and was closed the same day.

**WAL archiving is on:**

```
archive_mode = on
archive_command = copy "%p" "C:\srj-data\wal\%f"
archive_timeout = 300
wal_level = replica
```

Archive to a **local** folder, never to the NAS. The service account has no credential for `\\SRJNAS`, and a failing `archive_command` makes Postgres retain WAL until the disk fills. `C:\srj-data\wal` is granted full control to `NT AUTHORITY\NetworkService`.

Health: `SELECT archived_count, failed_count, last_archived_wal FROM pg_stat_archiver;` — `failed_count` must stay 0.

### 2.3 The pipeline

Go 1.27, built natively on the PC:

```powershell
cd "C:\SRJ Website Code Archive\srj-pipeline"
git pull ; go mod tidy ; go build -o pipeline.exe .
```

`pipeline.exe` is gitignored. It reads 58 environment variables from `C:\srj-data\pipeline.env`, a locked plain-text file (`icacls /inheritance:r`). Of the 58, about 24 are load-bearing; the rest skip their stage with a log line if absent.

**Invocation is always through `run-pipeline.ps1`**, never the binary directly, because that wrapper:

- loads `pipeline.env` into the process environment;
- refuses to start a stage already running (a lock file, stale after 3 hours) — the 3-hour schedule and a 25-minute run overlap on slow days, and two publishes fighting over the site is worse than one late run;
- writes a dated log per stage and keeps 30 days;
- writes the exit code to `logs\<stage>-last.txt`, which is the file a morning check reads.

**Scheduled tasks** (all as Stephen's account, not SYSTEM — SYSTEM has no credential for the NAS and no `pgpass.conf`):

| Task | Stage | Schedule (Central) |
|---|---|---|
| `srj-pipeline` | `all` | 00:05, every 3 hours |
| `srj-thinpage-scraper` | `thinpages` | 00:10 daily |
| `srj-inkbox-tick` | `inkbox_tick` | every 5 minutes |
| `srj-pg-nasdump` | dump to NAS | 01:45, every 6 hours |
| `srj-wal-ship` | WAL to NAS | every 15 minutes |

**Trap, recorded because it cost an hour:** do not name a PowerShell variable `$args` when building task arguments. It is an automatic variable and the arguments silently come out truncated. The tasks registered with a stage name and nothing else, and exited 1 before the script's first line.

### 2.4 The stage graph

`pipeline all` runs about sixty stages. The shape:

**Ingest** — federal_register, legiscan, gdelt, govinfo, openalex, arxiv_watch, twoai_policy_news, agency_watch, twoai_incidents, twoai_avid, twoai_owasp, twoai_atlas, mcp_registry, twoai_vendor_feeds, twoai_jobs, twoai_repos, twoai_models, twoai_grid, twoai_capex, twoai_ma, twoai_dc harvest.

**Enrich** — twoai_companyfacts, twoai_orgfacts, twoai_company_harvest, twoai_industry_hub, twoai_airports, twoai_claims, twoai_wikidata, twoai_siting_watch.

**Build** — twoai_build, which writes ~4,900 rows into `twoai_pages` across 64 page kinds.

**Publish** — twoai_embed (Workers AI, bge-m3), twoai_vectorize, twoai_publish, twoai_publish_r2, url_registry, twoai_indexnow, audit_sync, deploy_site.

**Once-a-day gating** uses `pipeline_stage_runs`. Gated: legiscan, intel, twoai_recap, twoai_claims, twoai_onet, twoai_openlibrary, twoai_case_studies, twoai_companyfacts, twoai_orgfacts, docwatch, arxiv_watch, export_corpus. Ungated stages run every three hours.

### 2.5 The three rules that shape the data

**1. Nothing is deleted.** Rows are marked `duplicate_of`, `retired_at` with a reason, or `superseded_by`. 48 statement-level triggers on 16 tables count every insert, update and delete into `twoai_ingest_ledger`; a `DELETE_VIOLATION` row is a stage to fix, not a statistic.

**2. Published pages never 404.** A retired page still serves 200. `twoai_url_registry` holds 11,840 URLs and probes overdue ones; the sitemap and the unlisted manifest between them account for every one.

**3. Prose cannot live in a regenerated row.** Any `twoai_pages` kind that a daily stage rewrites wholesale destroys hand-written keys. This was learned twice — 271 unrendered readings on 2 September, and the state law contexts wiped on 5 September. Hand-written prose lives in a **side table joined at build time**:

| Side table | Joins to | Page kind |
|---|---|---|
| `twoai_tool_category_intros` | slug | tool-category |
| `twoai_state_law_context` | slug | state-law, hub |
| `twoai_dc_facilities.profile` | facility id | dc-facility |
| `twoai_industry_analysis` | metric | several |

**Before writing prose into any page row, check whether a stage regenerates that kind.** If it does, build a side table first.

---

## 3. Cloudflare

### 3.1 Tunnel

`cloudflared` runs as a Windows service, holding **four QUIC connections** outbound to Cloudflare's edge on UDP 7844. No inbound ports, no port forwarding, no DMZ. The ASUS RT-BE92U passes it untouched with AiProtection on — verified 4 September.

Health: `Get-NetUDPEndpoint -OwningProcess (Get-Process cloudflared).Id` should show four. TCP connections on 443 instead mean it fell back to HTTP/2 — works, slower.

The tunnel exposes Postgres as a **Workers VPC Service**, `01a060aa-6092-7f00-8e15-ea8e40c079c4`. This is the modern form; it needs no Access service token.

**What a tunnel cannot do:** carry raw TCP to a non-Cloudflare client. This is why the Render MCP container could not follow the database and had to be rewritten as a Worker. Any future service that needs the database must either run on the PC or run as a Worker.

### 3.2 Hyperdrive

| Config | ID | Role | Bound as |
|---|---|---|---|
| `srj-audit-home` | `5c56ecd1dc9041b9b9de6ab8a1708623` | `twoai_reader` | `AUDIT_DB` (site), `HOME_DB` (MCP) |
| `srj-audit-home-writer` | `0fe11be26f5a48b49a4556ae5a3ac0c8` | `srj_mcp` | `HOME_DB_WRITE` (MCP) |
| `twoai-audit` *(legacy)* | `de0bbffadff8402d9e67383e71e0d3ac` | points at frozen Render | **unbind and delete after the Render database is suspended** |

Reads and writes use different bindings deliberately: a bug in a read path cannot write.

### 3.3 The site Worker

`twoai-site`, `src/worker.ts`, compatibility date 2026-08-01.

| Binding | Resource | Purpose |
|---|---|---|
| `ASSETS` | `./dist` | static pages, 404-page handling |
| `AUDIT_DB` | Hyperdrive reader | Ask box queries |
| `VECTORIZE` | index `twoai-pages` | semantic retrieval |
| `AI` | Workers AI | bge-m3 question embeddings, llama-guard shadow screen. Answers come from Ollama Cloud since 2026-09-21, see section 10 |
| `ASK_RATE`, `TALENT_RATE`, `TRANSLATE_RATE` | rate limit bindings | 10, 5 and 40 a minute per IP |
| `TRANSLATE_KV` | KV | Microsoft Translator cache and monthly counter |
| `ASSISTANT_DB` | D1 `twoai-assistant` | ask log, talent profiles |
| `TALENT_R2` | R2 `twoai-talent` | résumés |

Deployment is by git push: GitHub → Cloudflare build → live in about sixteen minutes. `deploy_site` polls `/api/sources.json` for up to 25 minutes and logs `twoai build verified live` or `TWOAI BUILD DID NOT SHIP`, non-fatally.

### 3.4 The MCP Worker

`srj-mcp.srjordan.workers.dev`, replacing the Render container. Five tools: `health_check`, `describe_schema`, `execute_sql`, `execute_write`, `list_tenants`.

- **Transport:** MCP Streamable HTTP, stateless — one JSON-RPC request per POST. No sessions, no SSE, no Durable Objects.
- **Auth:** a secret path segment, `MCP_PATH_TOKEN`, set by `wrangler secret put`. Claude's custom connectors send no headers of their own, so the token rides in the URL. Any other path returns a bare 404 — it does not even confirm an MCP server is there.
- **Read safety:** `execute_sql` checks the first keyword *and* runs inside a Postgres `READ ONLY` transaction, so a `WITH … DELETE` is refused by the database, not by a regex.
- **Write safety:** `execute_write` requires `confirm = "I-CONFIRM-WRITE"` exactly, and uses the writer binding.
- **Postgres.js on Workers:** `{ max: 1, fetch_types: false, idle_timeout: 5 }`, `sql.end()` in a `finally`. Hyperdrive pools; the Worker must not.

Source: `C:\SRJ Website Code Archive\srj-mcp-worker`. It is the template for any future Worker that needs the database.

### 3.5 Everything else on Cloudflare

R2 buckets for the content bundle and assets; Vectorize index `twoai-pages` (~13,000 vectors); D1 `twoai-assistant`; the `srj-home-dbproof` Worker, which is the canary that proved the tunnel on 2 September and is worth keeping.

---

## 4. Backup

Four layers, because each covers a different failure.

| Layer | Frequency | Loss window | Location | Proven |
|---|---|---|---|---|
| Verified dump | 4×/day from 01:45 | 6 hours | NAS, 90 days | restored 2026-09-05 |
| WAL archive | continuous, 5-min ceiling | **5 minutes** | local → NAS every 15 min | shipping |
| Base backup | weekly | — | NAS | taken 2026-09-04 |
| Veeam file backup | 3 am | 24 hours | NAS | Postgres data dir **excluded** |
| NAS → OneDrive | nightly | — | off-site | running |

**The dump script writes locally first, then copies.** A `pg_dump --jobs=4` directly onto SMB is slow and a network blip mid-write leaves a corrupt dump that still looks complete. Local disk is fast and reliable; the copy is the part that can safely retry. The script compares byte counts local versus remote and fails loudly on a mismatch.

**Veeam excludes `C:\Program Files\PostgreSQL\18\data`.** A file-level copy of a running Postgres is a torn snapshot: it looks complete, may restore, and you find out on the day you need it. Postgres is not a VSS-aware writer on Windows. The dumps are the restorable copy.

**The NAS SSD cache is read-only, Random I/O, 1 MB bypass.** A read-write cache on a single SSD can lose acknowledged writes and corrupt the volume; that volume holds the dumps.

### 4.1 A failure worth remembering

`nasdump.ps1` produced nothing from 4 September 22:55 until 5 September. The scheduled task reported `Ready` and exited 1 each time. Cause: console history had been pasted into the bottom of the file, so PowerShell rejected it before line 1 — the script's own `Log "start"` never ran, so the log simply stopped rather than showing an error.

**The lesson generalises: a job that fails before its logging starts is invisible.** Every scheduled script must write an exit-code file that the morning check reads, so silence is distinguishable from success. The pipeline tasks do this; `nasdump` did not, which is why it hid for a day.

---

## 5. The morning check

```powershell
Get-Content C:\srj-data\logs\all-last.txt
Get-Content C:\srj-data\logs\inkbox_tick-last.txt
Get-Content C:\srj-data\logs\nasdump-last.txt
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -d srj_audit -c "SELECT archived_count, failed_count FROM pg_stat_archiver;"
(Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count
```

Expected: `exit=0` on the first three, `failed_count` 0, cloudflared count 1. Anything else is the day's first job.

---

## 6. Rebuilding from bare metal

If the PC is replaced, in order:

1. Windows, then **disable sleep and hibernation**.
2. PostgreSQL 18. Leave it on `127.0.0.1`.
3. Restore the newest NAS dump: `pg_restore -U postgres -h localhost --create --dbname=postgres --jobs=4 <dump-dir>`.
4. Recreate roles `twoai_reader` and `srj_mcp` with their grants **and default privileges**.
5. Enable WAL archiving; create `C:\srj-data\wal` and grant `NetworkService` full control.
6. Go 1.27; clone both repos to `C:\SRJ Website Code Archive`; `go build -o pipeline.exe .`.
7. Restore `pipeline.env` from the password manager; lock it with `icacls`.
8. `cloudflared` service, same tunnel token. Confirm four QUIC connections.
9. Re-point the Hyperdrive configs at the new tunnel service if its ID changed.
10. Register the five scheduled tasks under Stephen's account.
11. `cmdkey` for the NAS; run `nasdump.ps1` by hand and confirm `copy ok, verified`.
12. Run `pipeline.exe all` once by hand and watch for `deploy_site: twoai build verified live`.

**Estimated: half a day**, most of it the restore and the first full run.

---

## 7. What is still on Render, and why

| Service | State | Decision |
|---|---|---|
| `srj-audit-db` | frozen 17:15 UTC 2026-09-05 | keep suspended a month as a cold copy, then delete |
| `srj-mcp` | superseded | suspend now — one request since the switch, and that was a probe |
| `srj-wikidata-mcp` | unknown | its owner decides; handoff issued |
| `srj-audit-web-gor5`, worker, `pgbouncer`, `srj-audit-redis-prod` | still live, **writing to the frozen copy** | its owner decides; handoff issued. Any platform activity after 17:15 exists only on Render |
| `focms-api`, `NorthStar-Scraper`, `outcomestar`, `PgHero` | different database | stays |

---

## 8. Known risks, stated plainly

**Single machine.** The database has no replica. Backups are good — four layers, one off-site, restore proven — but recovery is a restore, not a failover. An hour or two of downtime for the Ask box and MCP; the pages stay up throughout.

**Credentials in a chat transcript.** The `srj_mcp` password and the `MCP_PATH_TOKEN` passed through a conversation on 5 September. Stephen declined to rotate them. Recorded as a decision, not an oversight; two commands reverse it.

**The stale-clone trap.** The sandbox clone used for compile checks fell three commits behind origin on 5 September and reported the pre-cutover Hyperdrive ID. `AGENTS.md` in `srj-pipeline` requires fetch-before-write and verify-after-push for this reason. **Verify against `origin/main`, not the working copy.**

**Residential internet and power.** No UPS mentioned; a power cut takes the Ask box down until the machine returns. The pages do not care.

---

## 9. What changed from the August blueprint

| Blueprint said | Now |
|---|---|
| Everything on Render | Database, pipeline and MCP on the PC; Cloudflare in front |
| Content repo `twoai-content` via GitHub API | R2 bundle, GitHub-first override removed 4 September |
| Six page factories, 1,200–1,800 URLs | 64 page kinds, 4,928 page rows, 11,840 URLs |
| No data-centre registry | 1,840 facilities, an operator registry, a grid observatory, a siting-and-power law section |
| No Ask box | Ask box over 2.05 million works, Vectorize, Workers AI |
| No backup design | Four layers with a proven restore |

The blueprint's guardrails all survived and are unchanged: content lives in SQL, no fabrication, accuracy corrected immediately, paid content labelled, URLs permanent, brand tokens fixed.

---

## 10. Changes of 21 September 2026

Each item is logged in `site_arch_changelog`, seq 1136 to 1147.

### 10.1 Network and resilience

- **DNS.** The 20 September `all` run lost every outbound lookup from about 20:33 to after 20:52 Central, and nothing published. Root cause: Ethernet 3 resolved through the router at 192.168.0.1. It now uses 1.1.1.1 and 8.8.8.8, set with `Set-DnsClientServerAddress`. A run that logs `no such host` for every host is this, not an upstream outage.
- **Build failure found.** Every Workers Build from at least 11:49 UTC on 21 September failed in `src/pages/[page].astro`, `Missing parameter: page`, because `static/gaps.json` (the `twoai_gaps` measures) landed in `content/static/` with no slug. Fixed in twoai-site 8a54e7e: the route keeps only files with a slug and a sections array.
- **The local Windows build is not a deploy test.** `fetch-content` downloads to `/tmp`, fails, builds 72 pages and url-guard blocks. Only the Cloudflare build pulls the full bundle.

### 10.2 Site Worker and edge

- **Ask box answers from Ollama Cloud**, `deepseek-v4-pro`, through `https://ollama.com/api/chat` with the `OLLAMA_API_KEY` Worker secret (twoai-site 5bac5fd). It is the only answer attempt, the same no-fallback rule as the pipeline. Until then every answer since 2026-09-18 had come from `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI, billed in neurons. The duplicate bge-m3 embedding before the works index query was removed.
- **Workers AI spend** now comes from question embeddings, the guard, and pipeline `twoai_embed`. On 21 September `twoai_embed` re-embedded 21,893 of 28,876 chunks against a normal 20 to 700; cause not yet found.
- **Markdown for Agents is on.** `Accept: text/markdown` returns converted Markdown with `Content-Signal: ai-train=yes, search=yes, ai-input=yes`. Browsers get HTML.
- **Crawler policy is everyone welcome**, confirmed by Stephen: robots.txt allows all, training crawlers included. The WAF skip rule admits citation and training crawlers alike; `bingbot` corrected to lower case, since `contains` is case sensitive.
- **News entity chips** skip 42 company names that are ordinary words (switch, zoom, writer, runway and others) after Switch was chipped on the Newsom kill switch story. `src/lib/knownEntities.ts`.
- **Sources line** reads LegiScan, CourtListener, the Federal Register, and OpenAlex, in the footer and in About, Terms and Disclaimer.

### 10.3 The Politics of AI

Hub `politics-of-ai`, uid d9480073, under Enterprise Applications, Governance and Tools. Neutral by design: it records filings, votes, bills, money and statements with sources and never assigns a motive to a named person.

| Section | Slug | uid | State |
|---|---|---|---|
| Lobbying on AI | pol-lobbying | f97534ef | Page built, draft |
| Five Positions on AI | pol-positions | | Taxonomy only |
| Money Beside Votes | pol-money | | Taxonomy only, needs the member to FEC crosswalk |
| From Issue to Law | pol-outcomes | | Taxonomy only |
| Preemption Watch | pol-preemption | | Taxonomy only |
| Statements Beside Votes | pol-statements | | Taxonomy only, no feed |
| Export Controls and Compute Sovereignty | pol-export-controls | | Taxonomy only, feed live |
| Antitrust and Market Power | pol-antitrust | | Taxonomy only, feed existed |

New stages, all daily and in `all` after `twoai_fred`:

| Stage | File | Source | Keeps current by |
|---|---|---|---|
| `twoai_politics_lda` | twoai_politics.go | lda.gov filings (lda.senate.gov now 301s there) | Cursor per query, newest `dt_posted` less three days. `LDA_API_KEY` raises the limit from 15 to 120 a minute; 150 pages a run with it, 40 without |
| `twoai_politics_bills` | twoai_politics_bills.go | LegiScan US master list, getBill, getRollCall, getPerson | getBill only when `change_hash` moves, 150 a run; each roll call once; each unknown voter once |
| `twoai_politics_fec` | twoai_politics_fec.go | FEC API with `FEC_API_KEY` | Committees proposed by name search, read only once confirmed; Schedule B and Schedule E per committee from the newest held date less seven days |
| `twoai_politics_pages` | twoai_politics_pages.go | the tables above | Rebuilt every run; also proposes lobbying client to company matches |

`twoaiPoliticsCompanyPatch` (twoai_politics_companies.go) runs at the end of `twoaiBuild`, before the freshness stamp, and adds a `lobbying` key to each confirmed company document. The company template renders it and counts it as substance for the thin-page gate.

Tables, owner `srj_mcp`, select to `twoai_reader`, ledger triggers on all: `twoai_pol_lobbying`, `twoai_pol_bills`, `twoai_pol_members`, `twoai_pol_sponsorships`, `twoai_pol_rollcalls`, `twoai_pol_votes`, `twoai_pol_committees`, `twoai_pol_money`, `twoai_pol_client_matches`, `twoai_pol_lobbyist_people`. DDL in `C:\srj-data\sql\2026-09-21_*.sql`.

**Confirmation queues.** Nothing that rests on a name match is trusted until Stephen sets `status = 'confirmed'`: FEC committees (12 confirmed, Leading the Future C00916114 pending), lobbying clients to company pages, lobbyists to person pages. Lobbying firms get no pages; individual lobbyists are named on filing entries only.

**Measured on the first runs.** 289 AI bills among 18,956 in the session; 3,630 AI lobbying filings from 918 clients held, 12,355 still to backfill; 2,030 PAC contributions from 12 committees.

### 10.4 New coverage placed, feeds first

| Section | Parent | Feed |
|---|---|---|
| Content Provenance and Watermarking | ai-security-risk | existing law and news feeds |
| Frontier Model Evaluation (uid 66cd53db) | ai-security-risk | METR `metr.org/feed.xml`, AI Security Institute GOV.UK Atom, Frontier Model Forum `/feed/`, Apollo Research through Google News coverage (no first-party feed) |
| AI Policy Ledger | law-and-compliance | built from existing law data |
| EU, US and China Compared | law-and-compliance | built from existing pages |
| AI Assurance Standards (uid 36580344) | law-and-compliance | ISO 42001, 17021, 42006, 42005, 17025 |

- **Federal Register** gains four export control queries, `"advanced computing"`, `"model weights"`, `"Export Administration Regulations" AND semiconductor`, `"Entity List" AND semiconductor`, and `onSubject` gains `mentionsExport`. Measured before landing: 196 on-subject documents including the AI Diffusion framework and the UAE favorable treatment rule.
- **AISI coverage query** now searches both names; it had searched only AI Safety Institute, dropped on 2025-02-14.
- **Entities registered:** METR 2cd7a34a, AI Security Institute 73bc00b2, Frontier Model Forum 18549592, Apollo Research 8189a67e.
- **Benchmarks** are added through `twoai_benchmark_readings`: candidates in `twoai_benchmark_candidates`, harvested by `twoaiHarvestSources`, written by Ollama from the maintainer's page, promoted into `twoai_benchmarks` only when complete. Seeded with METR Time Horizon, HCAST and RE-Bench. `twoai_point_briefs` excludes sector `benchmarks`.

### 10.5 Environment added

| Name | Where | Purpose |
|---|---|---|
| `FEC_API_KEY` | pipeline.env | api.data.gov personal key, 1,000 calls an hour |
| `LDA_API_KEY` | pipeline.env | lda.gov token from `POST /api/auth/login/`, sent as `Authorization: Token` |
| `OLLAMA_API_KEY` | Worker secret, twoai-site | Ask box answers |

### 10.6 Still open

- Member to FEC candidate crosswalk through `opensecrets_id`, which Money Beside Votes needs.
- Site uids for lobbying clients, and company pages for unmatched clients, which need a hard identifier source.
- Bill numbers in lobbying filings span the 118th and 119th Congresses and are shown as filed.
- The 21 September `twoai_embed` reindex cause.
- `twoai_gaps` reports `relation "twoai_feed_candidates" does not exist`.
- The Ollama key was pasted into a terminal as a secret name on 21 September; rotation advised.

### 10.7 Bills, lobbying firms and lobbyists as pages (changelog 1150, 1151)

Stephen reversed the earlier decision: lobbying firms and lobbyists get pages, cross referenced with AI bills, AI people and companies. `twoai_politics_directory.go`, called from `twoai_politics_pages` after the exports.

| Page family | Path | Keyed on | Links to |
|---|---|---|---|
| AI bill | `industries/pol-bill-<uid>.json` | LegiScan bill_id | sponsors' member timelines, roll calls, clients whose 2025 or later filings name it (company page when confirmed), congress.gov |
| Lobbying firm | `industries/pol-firm-<uid>.json` | LDA registrant id | clients, its lobbyists, AI bills named |
| Lobbyist | `industries/pol-lobbyist-<uid>.json` | LDA lobbyist id, never name | firms, clients, AI bills named, prior government positions as disclosed, AI People profile only when confirmed |
| Member timeline | `industries/pol-member-<uid>.json` | LegiScan people_id | bill pages, votes, committee money, AI People profile by Wikidata id |
| Indexes | `pol-bills` 928bd470, `pol-firms` ef995158, `pol-lobbyists` b954389e | | the 300 largest of each |

Bill references in filings map H.R. to HB, S. to SB, H.Res. to HR, S.Res. to SR, and only for filings reporting on 2025 or later, since the same number in an earlier filing is a 118th Congress bill. On 21 September, 112 of 889 such references matched an AI bill already held. Company pages link each filing's firm and lobbyists to their pages. New tables `twoai_pol_firms`, `twoai_pol_lobbyists`, `twoai_pol_filing_lobbyists`; press room tables `twoai_pol_legislators`, `twoai_pol_candidate_committees`. All pages are drafts.
