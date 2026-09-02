"""
BigQuery AI Query Optimizer — Cloud Function backend.

Receives a SQL query from the Chrome extension, enriches it with live table
metadata from the BigQuery API, runs an 8-point audit checklist via Vertex AI
Gemini, and returns the analysis as JSON.

Runtime: Python 3.11+
Trigger: HTTP
Entry point: analyze_query

Environment variables (all optional — sensible defaults are used):
  GCP_PROJECT          Project used for Vertex AI + BigQuery clients.
                       Defaults to the project the function is deployed in.
  VERTEX_LOCATION      Vertex AI region (default: us-central1).
  MODEL_NAME           Gemini model ID (default: gemini-2.5-flash-lite).
  DRY_RUN_THRESHOLD_GB Queries estimated below this are flagged as "cheap"
                       in the extension UI (default: 250).
  ORG_CONTEXT          Optional free-text description of your own data
                       platform (projects, datasets, naming conventions,
                       partition conventions). Appended to the system prompt
                       so the model gives advice specific to your warehouse.
                       If unset, the function looks for an `org-context.txt`
                       file next to this module. See org-context.example.txt.
"""

import json
import os
import re
import time

import functions_framework
import vertexai
from flask import jsonify
from google.cloud import bigquery
from vertexai.generative_models import GenerationConfig, GenerativeModel

# ── Config ──────────────────────────────────────────────────────────────
# In Cloud Functions / Cloud Run, GOOGLE_CLOUD_PROJECT is set automatically,
# so the function works with zero configuration out of the box.
PROJECT_ID = (
    os.environ.get("GCP_PROJECT")
    or os.environ.get("GOOGLE_CLOUD_PROJECT")
    or os.environ.get("GCLOUD_PROJECT")
)
LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
MODEL_NAME = os.environ.get("MODEL_NAME", "gemini-2.5-flash-lite")

# Estimated bytes below which a query is considered cheap enough to just run.
DRY_RUN_THRESHOLD_BYTES = int(os.environ.get("DRY_RUN_THRESHOLD_GB", "250")) * (1024**3)

vertexai.init(project=PROJECT_ID, location=LOCATION)
bq_client = bigquery.Client(project=PROJECT_ID)


def load_org_context() -> str:
    """Load optional organisation-specific warehouse context.

    Resolution order:
      1. ORG_CONTEXT environment variable.
      2. `org-context.txt` sitting next to this module (bundled at deploy time).
      3. Empty string — the model then relies purely on live table metadata.
    """
    inline = os.environ.get("ORG_CONTEXT", "").strip()
    if inline:
        return inline

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "org-context.txt")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        return ""
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[BQ-Opt] Could not read org-context.txt: {exc}")
        return ""


ORG_CONTEXT = load_org_context()


# ── System Prompt (audit checklist) ─────────────────────────────────────
SYSTEM_PROMPT = """You are a senior BigQuery optimization expert reviewing SQL for a data platform team.
Analyze the given SQL query and respond ONLY with valid JSON (no markdown, no explanation outside JSON).

═══════════════════════════════════════════════════════════════════
ABSOLUTE RULE #1 — ALWAYS RETURN A FULL OPTIMIZED QUERY:
═══════════════════════════════════════════════════════════════════
You MUST ALWAYS return a COMPLETE, RUNNABLE optimized SQL query in the "optimized_query" field.
NEVER return just column names or a partial query. The optimized_query must be a full SQL statement
that the user can copy-paste and run directly in BigQuery.

WHAT TO INCLUDE IN THE OPTIMIZED QUERY:
1. PARTITION FILTERS: If a table is partitioned and the original query has NO partition filter,
   ADD a recommended partition filter with a comment explaining it:
   -- ⚠️ RECOMMENDED: Add partition filter to avoid full table scan (table is X GB)
   ALWAYS use DATE() wrapper + DATE_SUB pattern regardless of column type:
   * TIMESTAMP column → WHERE DATE(col) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   * DATE column → WHERE col >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   * DATETIME column → WHERE DATE(col) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   Example: WHERE DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)

2. REPLACE SELECT * with explicit column names (use the column metadata provided).
   Only list columns that are actually used downstream in JOINs, WHERE, GROUP BY, or final output.

3. ADD CLUSTERING HINTS as comments:
   -- 💡 TIP: This table is clustered by [fields]. Filter/ORDER on these for best performance.

4. PUSH FILTERS EARLY: If a WHERE filter is applied late (in a final SELECT or outer CTE),
   MOVE it into the earliest CTE that reads the physical table.

5. SUGGEST APPROX_COUNT_DISTINCT: Replace COUNT(DISTINCT high_cardinality_col) with
   APPROX_COUNT_DISTINCT(high_cardinality_col) and add a comment explaining the ~1% error trade-off.

6. FOR JOINS: Add comments about join optimization:
   -- ⚠️ Consider filtering this table before joining (currently X GB unfiltered)

STRUCTURAL RULES:
- Keep ALL CTEs intact — never remove, merge, or eliminate them.
- CTE names (e.g. "joined_data", "daily_agg") are NOT real BigQuery tables.
- Never invent or fabricate table names.
- Keep the final SELECT columns the same (same output schema).
- Keep JOIN conditions logically equivalent.
- Keep GROUP BY and ORDER BY intact.
- Any NEW WHERE clause you add for partition pruning MUST have a comment explaining it's a recommendation.

═══════════════════════════════════════════════════════════════════
MANDATORY AUDIT CHECKLIST — Run ALL 8 checks for every query:
═══════════════════════════════════════════════════════════════════

CHECK 1 — LIMIT WITHOUT WHERE:
- Flag if LIMIT is used without a WHERE clause.
- Recommend using BigQuery's PREVIEW tab instead of LIMIT for sampling data.
- In optimized_query: add a comment -- ⚠️ LIMIT without WHERE still scans full table. Use PREVIEW tab instead.
- Severity: warning

CHECK 2 — LOGICAL PRECEDENCE (OR without parentheses):
- Flag if OR is used near a partition filter without parentheses.
- In optimized_query: add parentheses to fix the precedence.
- Severity: warning

CHECK 3 — FILTER EARLY (push filters into CTEs):
- CRITICAL check. If a filter on a large table is only in the final SELECT but NOT in the CTE that reads the physical table, flag it.
- In optimized_query: MOVE the filter into the earliest CTE and add a comment -- ⚠️ MOVED: filter pushed early to reduce scan
- Severity: critical

CHECK 4 — PARTITION FILTER AUDIT (MOST IMPORTANT CHECK):
- For EVERY physical table reference, check if the TABLE METADATA shows a partition field.
- If the metadata shows a partition field and the query does NOT filter on it, you MUST:
  a) Report it as a critical/warning issue with the table name, partition field, and table size
  b) ADD a recommended partition filter in the optimized_query with a clear comment:
     -- ⚠️ RECOMMENDATION: Add partition filter on [field] to avoid scanning [X GB]
     -- Remove or adjust the date range below based on your actual data needs
     IMPORTANT — TYPE-SAFE FILTER RULES:
     * ALWAYS use DATE() wrapper + DATE_SUB pattern for partition filters.
     * If the partition field is TIMESTAMP: use DATE(col) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
       Example: WHERE DATE(created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
     * If the partition field is DATE: use col >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
       Example: WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
     * If the partition field is DATETIME: use DATE(col) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
     * If the table is ingestion-time partitioned (_PARTITIONTIME / _PARTITIONDATE):
       use DATE(_PARTITIONTIME) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
     * NEVER use TIMESTAMP_SUB or DATETIME_SUB — always wrap with DATE() and use DATE_SUB.
- Check ALL tables — if 5 tables are queried and 3 are missing filters, add filters for all 3.
- Severity: critical if table > 1GB, warning if smaller

CHECK 5 — SELECT * USAGE:
- Flag every SELECT * anywhere in the query.
- In optimized_query: REPLACE SELECT * on physical tables with explicit column names from metadata.
  Only include columns actually used downstream (in JOINs, WHERE, GROUP BY, SELECT, etc.).
  Add a comment: -- ✅ OPTIMIZED: SELECT * replaced with specific columns (saves bytes scanned)
- For SELECT * in intermediate CTEs referencing other CTEs: keep it but add info comment.
- Severity: critical (physical tables), info (CTE references)

CHECK 6 — EXPENSIVE JOINS:
- Flag JOINs between large tables without filters.
- Flag duplicate table joins.
- Flag CROSS JOINs and joins on non-clustered high-cardinality keys.
- In optimized_query: add comments with join optimization suggestions.
- Severity: info

CHECK 7 — CLUSTERING UTILISATION:
- If the TABLE METADATA shows clustering fields, check whether the query filters,
  joins, or aggregates on the LEADING clustering field.
- If it does not, flag it and explain that block pruning is being wasted.
- In optimized_query: add a comment
  -- 💡 TIP: Table is clustered by [fields]. Filtering on [leading field] enables block pruning.
- If the ORG CONTEXT below describes incremental/CDC or pre-aggregated alternatives
  to the tables in this query, recommend the cheaper alternative here as well.
- Severity: info

CHECK 8 — APPROX_COUNT_DISTINCT:
- If COUNT(DISTINCT col) is used on high-cardinality columns, replace it.
- In optimized_query: replace with APPROX_COUNT_DISTINCT(col) -- ✅ ~1% error but much faster
- Severity: info

═══════════════════════════════════════════════════════════════════
SCORING RULES:
═══════════════════════════════════════════════════════════════════
- Start at 100 and deduct points:
  * Missing partition filter on a table > 1GB: -15 points each
  * Missing partition filter on a table < 1GB: -5 points each
  * SELECT * on a physical table in a CTE: -10 points each
  * SELECT * in intermediate/final CTE: -3 points each
  * LIMIT without WHERE: -5 points
  * OR without parentheses near partition filter: -10 points
  * Late filtering (filter in final SELECT instead of early CTE): -15 points
  * Clustered table queried without using its leading clustering field: -5 points each
- Minimum score: 5
- grade: "excellent" (≥95), "good" (≥75), "fair" (≥50), "poor" (≥25), "critical" (<25)
- If NO issues found: score 100, grade "excellent"

═══════════════════════════════════════════════════════════════════
OPTIMIZED QUERY FORMAT RULES:
═══════════════════════════════════════════════════════════════════
The optimized_query MUST be:
- A COMPLETE SQL query (not just column names, not partial)
- Runnable in BigQuery (syntactically valid SQL)
- Include ALL CTEs from the original
- Include helpful comments (-- ⚠️ RECOMMENDATION, -- ✅ OPTIMIZED, -- 💡 TIP)
- Use \\n for newlines inside the JSON string

EXAMPLE of good optimized_query for "SELECT * FROM `project.dataset.table` LIMIT 10":
-- ✅ OPTIMIZED: Replaced SELECT * with specific columns\\n-- ⚠️ RECOMMENDATION: Add partition filter on event_date (table is 45.2 GB)\\n-- Remove or adjust the date range below based on your needs\\nSELECT\\n  user_id,\\n  event_name,\\n  event_date,\\n  platform\\nFROM `project.dataset.table`\\nWHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) -- ⚠️ Recommended partition filter\\nLIMIT 10 -- ⚠️ Consider using PREVIEW tab instead

═══════════════════════════════════════════════════════════════════

CRITICAL JSON RULES:
- All newlines inside string values MUST be escaped as \\n
- All backticks inside string values MUST be escaped
- The optimized_query field must be a single-line string with \\n for newlines
- Do NOT use actual line breaks inside JSON string values

Respond in this exact structure:
{"score": <integer 1-100>, "grade": "<critical|poor|fair|good|excellent>", "issues": [{"severity": "<critical|warning|info>", "title": "<short title>", "description": "<detailed description including table name, size, partition field, and specific recommendation>"}], "optimized_query": "<COMPLETE optimized SQL query with \\n for newlines — must be a full runnable query>", "explanation": "<paragraph explaining ALL key findings: which tables are missing partition filters, estimated scan savings, SELECT * waste, and join improvements>"}

GENERAL BIGQUERY GUIDANCE:
- Partition pruning is the single biggest cost lever — always check it first.
- Clustering enables block pruning, but only when the leading clustering field is filtered.
- APPROX_COUNT_DISTINCT is preferred over COUNT(DISTINCT) for high-cardinality columns.
- Prefer incremental/date-bounded reads over full-history scans.
- Warn about cross-region reads: BigQuery cannot join datasets across regions."""


def build_system_prompt(metadata_text: str) -> str:
    """Assemble the final system prompt: checklist + org context + live metadata."""
    prompt = SYSTEM_PROMPT
    if ORG_CONTEXT:
        prompt += (
            "\n\nORG CONTEXT (this organisation's data platform — prefer these "
            "conventions and named alternatives when relevant):\n" + ORG_CONTEXT
        )
    return prompt + metadata_text


# ── Helper: extract table references ────────────────────────────────────
def extract_table_refs(sql: str) -> list[dict]:
    """Extract fully-qualified `project.dataset.table` refs from SQL."""
    pattern = r"`([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)`"
    tables = []
    seen = set()
    for m in re.finditer(pattern, sql):
        key = f"{m.group(1)}.{m.group(2)}.{m.group(3)}"
        if key not in seen:
            seen.add(key)
            tables.append(
                {
                    "project": m.group(1),
                    "dataset": m.group(2),
                    "table": m.group(3),
                }
            )
    return tables


# ── Helper: fetch BQ table metadata ────────────────────────────────────
def fetch_table_metadata(ref: dict) -> dict | None:
    """Fetch partitioning, clustering, columns and size from the BigQuery API."""
    try:
        table_id = f"{ref['project']}.{ref['dataset']}.{ref['table']}"
        table = bq_client.get_table(table_id)

        columns = [
            {
                "name": f.name,
                "type": f.field_type,
                "mode": f.mode,
                "description": f.description or "",
            }
            for f in table.schema
        ]

        partitioning = None
        if table.time_partitioning:
            partitioning = {
                "type": table.time_partitioning.type_ or "DAY",
                "field": table.time_partitioning.field or "_PARTITIONTIME",
            }
        elif table.range_partitioning:
            partitioning = {
                "type": "RANGE",
                "field": table.range_partitioning.field or "unknown",
            }

        clustering = None
        if table.clustering_fields:
            clustering = {"fields": list(table.clustering_fields)}

        size_bytes = table.num_bytes or 0
        size_gb = f"{size_bytes / (1024**3):.2f} GB"

        return {
            "fullName": table_id,
            "columns": columns,
            "partitioning": partitioning,
            "clustering": clustering,
            "numRows": str(table.num_rows or "unknown"),
            "sizeGB": size_gb,
            "sizeBytes": size_bytes,
        }
    except Exception as e:
        # Most common cause: the function's service account lacks
        # bigquery.metadataViewer on that project. Analysis still proceeds.
        print(f"[BQ-Opt] Could not fetch metadata for {ref}: {e}")
        return None


def build_metadata_text(sql: str) -> str:
    """Fetch metadata for all tables in the query and format it as prompt text."""
    refs = extract_table_refs(sql)
    if not refs:
        return ""

    results = [fetch_table_metadata(r) for r in refs]
    valid = [r for r in results if r is not None]
    if not valid:
        return ""

    text = (
        "\n\nTABLE METADATA (from BigQuery API — use these REAL column names "
        "and partition info):"
    )

    for meta in valid:
        text += f"\n\nTable: {meta['fullName']}"
        text += f"\n  Size: {meta['sizeGB']} | Rows: {meta['numRows']}"

        if meta["partitioning"]:
            p = meta["partitioning"]
            text += f"\n  Partitioned by: {p['field']} ({p['type']})"
            text += f"\n  → IMPORTANT: Check if user's WHERE clause filters on {p['field']}"
        else:
            text += "\n  Partitioning: NONE"

        if meta["clustering"]:
            fields = meta["clustering"]["fields"]
            text += f"\n  Clustered by: {', '.join(fields)}"
            text += f"\n  → Leading clustering field is {fields[0]} — filtering on it enables block pruning"

        text += "\n  Columns:"
        for col in meta["columns"][:40]:  # cap at 40 cols to save tokens
            desc = f" -- {col['description']}" if col["description"] else ""
            required = ", REQUIRED" if col["mode"] == "REQUIRED" else ""
            text += f"\n    - {col['name']} ({col['type']}{required}){desc}"

    return text


# ── Helper: dry run to estimate bytes processed ──────────────────────────
def estimate_bytes_processed(sql: str) -> int | None:
    """Run a BigQuery dry run to estimate total bytes processed.

    Returns the byte count, or None if the dry run fails (syntax error,
    missing table, missing permissions). Dry runs are free.
    """
    try:
        job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
        query_job = bq_client.query(sql, job_config=job_config)
        return query_job.total_bytes_processed
    except Exception as e:
        print(f"[BQ-Opt] Dry run failed (will proceed with AI analysis): {e}")
        return None


# ── Helper: build user prompt ───────────────────────────────────────────
def build_user_prompt(query: str) -> str:
    """Build the user prompt with full optimization instructions."""
    cte_count = len(re.findall(r"\b\w+\s+AS\s*\(", query, re.IGNORECASE))
    line_count = query.count("\n") + 1

    table_refs = list(
        set(re.findall(r"`[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+`", query))
    )

    prompt = "Run the MANDATORY AUDIT CHECKLIST on this BigQuery SQL query.\n"
    prompt += (
        f"Query stats: {cte_count} CTEs, {line_count} lines, "
        f"{len(table_refs)} unique physical tables.\n\n"
    )

    prompt += "IMPORTANT INSTRUCTIONS:\n"
    prompt += "1. Return a FULL, COMPLETE, RUNNABLE optimized SQL query in optimized_query.\n"
    prompt += "2. For EVERY partitioned table missing a partition filter: ADD a recommended WHERE clause with a comment.\n"
    prompt += "3. Replace SELECT * with explicit column names (only columns used downstream).\n"
    prompt += "4. Add helpful comments (-- ⚠️ RECOMMENDATION, -- ✅ OPTIMIZED, -- 💡 TIP) throughout.\n"
    prompt += "5. Keep ALL CTEs — never remove or merge them.\n"
    prompt += "6. CTE names (like 'joined_data', 'daily_agg') are NOT real tables — never qualify them with project.dataset.\n"
    prompt += "7. Push filters as early as possible into the CTEs that read physical tables.\n"
    prompt += "8. For COUNT(DISTINCT) on high-cardinality keys, replace with APPROX_COUNT_DISTINCT.\n"

    prompt += f"\nPhysical tables to audit ({len(table_refs)}): {', '.join(table_refs)}\n"
    prompt += "Check EACH table above for: partition filters, SELECT *, clustering opportunities, join efficiency.\n\n"
    prompt += "SQL QUERY:\n"
    prompt += query

    return prompt


# ── Main endpoint ───────────────────────────────────────────────────────
@functions_framework.http
def analyze_query(req):
    """HTTP Cloud Function entry point."""

    # Handle CORS preflight
    if req.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "3600",
        }
        return ("", 204, headers)

    cors_headers = {"Access-Control-Allow-Origin": "*"}

    if req.method != "POST":
        return (jsonify({"error": "Method not allowed"}), 405, cors_headers)

    body = req.get_json(silent=True)
    if not body or "query" not in body:
        return (jsonify({"error": "Missing 'query' in request body"}), 400, cors_headers)

    query = body["query"].strip()
    if len(query) < 5:
        return (jsonify({"error": "Query too short"}), 400, cors_headers)

    # Dry-run-only mode: free pre-check, no AI call, no Vertex AI cost.
    dry_run_only = body.get("dry_run_only", False)

    start_time = time.time()

    try:
        # 0. Dry run — estimate bytes processed (free)
        estimated_bytes = estimate_bytes_processed(query)
        estimated_gb = None
        threshold_gb = DRY_RUN_THRESHOLD_BYTES / (1024**3)

        if estimated_bytes is not None:
            estimated_gb = round(estimated_bytes / (1024**3), 2)
            print(f"[BQ-Opt] Dry run: {estimated_gb} GB (threshold: {threshold_gb:.0f} GB)")

        if dry_run_only:
            elapsed = time.time() - start_time
            return (
                jsonify(
                    {
                        "dry_run_only": True,
                        "_estimated_gb": estimated_gb,
                        "_estimated_bytes": estimated_bytes,
                        "_threshold_gb": int(threshold_gb),
                        "_below_threshold": (
                            estimated_gb is not None and estimated_gb < threshold_gb
                        ),
                        "_elapsed_seconds": round(elapsed, 1),
                    }
                ),
                200,
                cors_headers,
            )

        # 1. Fetch live table metadata from BigQuery
        metadata_text = build_metadata_text(query)
        full_system_prompt = build_system_prompt(metadata_text)

        # 2. Build user prompt
        user_prompt = build_user_prompt(query)

        print(f"[BQ-Opt] Model: {MODEL_NAME}")
        print(
            f"[BQ-Opt] System prompt: {len(full_system_prompt)} chars, "
            f"User prompt: {len(user_prompt)} chars"
        )

        # 3. Call Vertex AI Gemini
        model = GenerativeModel(MODEL_NAME, system_instruction=[full_system_prompt])

        response = model.generate_content(
            user_prompt,
            generation_config=GenerationConfig(
                max_output_tokens=32768,
                temperature=0.1,
            ),
        )

        elapsed = time.time() - start_time
        raw_text = response.text
        print(f"[BQ-Opt] Response in {elapsed:.1f}s, {len(raw_text)} chars")

        # 4. Clean and parse JSON
        clean = re.sub(r"```json|```", "", raw_text).strip()

        try:
            result = json.loads(clean)
        except json.JSONDecodeError:
            # Retry after repairing common issues (raw newlines inside strings)
            result = json.loads(repair_json(clean))

        result["_model"] = MODEL_NAME
        result["_elapsed_seconds"] = round(elapsed, 1)
        result["_estimated_gb"] = estimated_gb
        result["_threshold_gb"] = int(threshold_gb)
        result["_below_threshold"] = (
            estimated_gb is not None and estimated_gb < threshold_gb
        )

        print(
            f"[BQ-Opt] Score: {result.get('score')}, "
            f"Issues: {len(result.get('issues', []))}"
        )

        return (jsonify(result), 200, cors_headers)

    except Exception as e:
        elapsed = time.time() - start_time
        print(f"[BQ-Opt] Error after {elapsed:.1f}s: {e}")
        return (
            jsonify({"error": str(e), "_elapsed_seconds": round(elapsed, 1)}),
            500,
            cors_headers,
        )


def repair_json(text: str) -> str:
    """Fix common JSON issues like unescaped newlines and tabs inside strings."""
    in_string = False
    escaped = False
    result = []

    for ch in text:
        if escaped:
            result.append(ch)
            escaped = False
            continue
        if ch == "\\" and in_string:
            result.append(ch)
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            result.append(ch)
            continue
        if in_string and ch == "\n":
            result.append("\\n")
            continue
        if in_string and ch == "\r":
            continue
        if in_string and ch == "\t":
            result.append("\\t")
            continue
        result.append(ch)

    return "".join(result)
