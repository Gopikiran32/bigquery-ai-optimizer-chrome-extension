# BigQuery AI Query Optimizer

A Chrome extension that reviews your BigQuery SQL before you run it, right inside the Google Cloud Console. It tells you how many gigabytes the query will scan, flags the things that make BigQuery bills large — missing partition filters, `SELECT *`, late filtering, unused clustering — and hands back a complete, runnable optimized version of your query.

The AI runs in a Cloud Function **in your own GCP project**, against **your own** Vertex AI quota. Your SQL and your table schemas never leave your organisation, and there is no service in the middle to trust.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## Why bother

BigQuery charges by bytes scanned, and the difference between a good query and a careless one is often two orders of magnitude on the same table. The mistakes are boring and repetitive: someone forgets the partition filter, or writes `SELECT *` against a 4 TB table to look at three columns, or filters in the outer query instead of inside the CTE that actually reads the table.

Those are exactly the mistakes a reviewer catches in five seconds and a busy analyst makes every week. This puts that reviewer in the console, before the query runs.

## What it actually does

When you open the panel, it runs a **free BigQuery dry run** and shows the estimated scan size. That number alone is often enough — if the query is 0.4 GB you close the panel and just run it, and you have spent nothing.

If you click **Analyze Query**, the backend does three things. It pulls live metadata for every table in your query from the BigQuery API: partitioning field and type, clustering fields, full schema, row count, physical size. It sends that metadata alongside your SQL to Gemini with a fixed eight-point audit checklist. Then it returns a score out of 100, a list of issues by severity, a plain-language explanation, and a rewritten query with inline comments marking every change.

The metadata step is the part that makes the output trustworthy. The model is not guessing that a column is a partition key or inventing column names — it is being told, by the BigQuery API, exactly what the table looks like.

### The eight checks

| # | Check | Typical severity |
|---|-------|------------------|
| 1 | `LIMIT` with no `WHERE` (still scans the whole table) | warning |
| 2 | `OR` near a partition filter without parentheses | warning |
| 3 | Filters applied late instead of pushed into the reading CTE | critical |
| 4 | Partitioned table queried with no partition filter | critical |
| 5 | `SELECT *` on a physical table | critical |
| 6 | Unfiltered joins between large tables, duplicate joins, cross joins | info |
| 7 | Clustered table queried without using its leading clustering field | info |
| 8 | `COUNT(DISTINCT …)` on a high-cardinality column | info |

Check 4 is the one that pays for the whole thing. When the model adds a partition filter it always uses the type-safe form — `WHERE DATE(col) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)` — so the suggestion runs as-is whether the column is `DATE`, `DATETIME` or `TIMESTAMP`, instead of failing with a signature mismatch.

## How it fits together

```
┌──────────────────────────────────────┐
│  Chrome (BigQuery console)           │
│                                      │
│  page-script.js  (MAIN world)        │  reads the full query text
│        ↕ hidden DOM bridge           │  from the Monaco editor
│  content.js      (isolated world)    │  renders the panel
└──────────────┬───────────────────────┘
               │  HTTPS POST { query }
               ▼
┌──────────────────────────────────────┐
│  Cloud Function (your GCP project)   │
│                                      │
│  1. BigQuery dry run   → bytes       │  free
│  2. BigQuery get_table → metadata    │  free
│  3. Vertex AI Gemini   → audit JSON  │  the only paid step
└──────────────────────────────────────┘
```

Reading the query out of the console turns out to be the fiddly part. BigQuery uses the Monaco editor and does not expose it as a global, and the visible DOM only contains the lines currently scrolled into view — so a naive scrape silently truncates long queries. The extension tries four strategies in order: a bridge into the page's own JS context to reach the editor API, a simulated select-all-and-copy through the clipboard, Monaco's hidden accessibility textarea, and finally the visible DOM lines as a last resort.

## What it costs

The dry run and the metadata lookups are free. The only paid call is Gemini, which with the default `gemini-2.5-flash-lite` runs to a fraction of a cent per analysis — typically a few thousand input tokens for the checklist plus your schema, and a few thousand output tokens for the rewritten query.

Set against a single 2 TB query you avoided, it does not register. The pre-check banner exists precisely so you can skip the AI call on queries too small to be worth it; the `DRY_RUN_THRESHOLD_GB` setting controls where that line sits.

---

## Setup

You need two things: the backend deployed in your GCP project, and the extension loaded in Chrome. Budget about ten minutes.

### Prerequisites

- A GCP project with billing enabled, and permission to deploy Cloud Functions in it
- The [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), authenticated (`gcloud auth login`)
- Chrome, Edge, or any Chromium browser
- Vertex AI available in the region you pick — [check Gemini model availability](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)

### Step 1 — Deploy the backend

Clone the repo and enable the APIs the function needs:

```bash
git clone https://github.com/Gopikiran32/bigquery-ai-optimizer-chrome-extension.git
cd bigquery-ai-optimizer-chrome-extension

export PROJECT_ID="your-project-id"
export REGION="us-central1"

gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  bigquery.googleapis.com \
  --project="$PROJECT_ID"
```

Then deploy:

```bash
cd cloud-function
./deploy.sh
```

`deploy.sh` reads `PROJECT_ID` and `REGION` from your environment, falls back to your active gcloud project, and prints the function URL when it finishes. **Copy that URL** — you need it in step 3.

If you did not set `SERVICE_ACCOUNT`, the function runs as your project's default compute service account. Grant it read access to BigQuery:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for ROLE in roles/bigquery.dataViewer roles/bigquery.metadataViewer roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA}" --role="$ROLE" --condition=None
done
```

`jobUser` lets it submit dry runs, and the two viewer roles let it read table metadata. It never needs write access to anything.

Verify the deployment with a free call — a dry run of `SELECT 1`, no Vertex AI involved:

```bash
curl -sS -X POST "YOUR_FUNCTION_URL" \
  -H 'Content-Type: application/json' \
  -d '{"query": "SELECT 1", "dry_run_only": true}'
```

A JSON response containing `"dry_run_only": true` means the backend is healthy.

### Step 2 — Load the extension

The extension is not on the Chrome Web Store, so load it unpacked:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from this repo

It stays installed across restarts. Chrome will show a "Disable developer mode extensions" nag on some startups — that is expected for unpacked extensions.

### Step 3 — Point it at your backend

The settings page opens by itself the first time you install. If you closed it, reach it again from the extension's card in `chrome://extensions` → **Details** → **Extension options**, or from the gear icon in the panel itself.

Paste your function URL, click **Save**, then click **Test connection** to confirm the two can talk. The test uses dry-run mode, so it costs nothing.

There is nothing to edit in any source file. If you later redeploy to a different project or region, just change the URL here.

### Step 4 — Use it

Open the BigQuery console, write a query, and click **◆ AI Optimize** — it appears in the query toolbar, or floats bottom-right if the toolbar layout has changed. The panel opens with the dry-run estimate already filled in.

The banner is colour-coded: yellow means the query is below your threshold and probably not worth an AI call, green means it is worth analyzing, and red means it is very large. Click **Analyze Query** when you want the full audit. Results arrive in three tabs — Issues, Optimized Query, Explanation — and **Apply Optimized Query** copies the rewrite to your clipboard so you can paste it over the original.

Treat the rewrite as a strong suggestion, not gospel. It is generated code against your real schema, and the date ranges in particular are guesses about your intent — read the diff before you run it.

---

## Configuration

### Backend (environment variables on the Cloud Function)

| Variable | Default | What it does |
|----------|---------|--------------|
| `GCP_PROJECT` | the deployed project | Project used for the BigQuery and Vertex AI clients |
| `VERTEX_LOCATION` | `us-central1` | Vertex AI region; must support your model |
| `MODEL_NAME` | `gemini-2.5-flash-lite` | Any Gemini model your project can call |
| `DRY_RUN_THRESHOLD_GB` | `250` | Below this, the extension flags the query as too small to be worth optimizing |
| `ORG_CONTEXT` | unset | Free-text description of your warehouse; see below |

Change any of them by editing the defaults at the top of `deploy.sh`, or by exporting them before you run it:

```bash
MODEL_NAME="gemini-2.5-pro" DRY_RUN_THRESHOLD_GB=50 ./deploy.sh
```

`gemini-2.5-flash-lite` is a deliberate default — it is fast and cheap, and the checklist plus real schema metadata does most of the heavy lifting. If you find the rewrites on very complex CTE chains unsatisfying, a larger model is the first thing to try.

### Extension

Two settings, both on the options page: the Cloud Function URL, and a verbose-logging toggle that is off by default so a normal install leaves your console clean. For logs from the page-script side, set `localStorage.bqOptDebug = '1'` in the console on the BigQuery tab.

---

## Teaching it about your warehouse

Out of the box the optimizer knows everything the BigQuery API can tell it about the tables in your query, which is a lot. What it cannot know is your conventions — which project is production, which dataset is a raw landing zone, and above all **which cheaper table the person should have queried instead**.

That last one is where most of the remaining value is. "This is a nightly full snapshot; use the CDC stream for incremental reads" or "there is a pre-aggregated daily rollup that answers this exact question" is advice no amount of schema inspection will produce.

Copy the example and fill in your own:

```bash
cd cloud-function
cp org-context.example.txt org-context.txt
$EDITOR org-context.txt
./deploy.sh
```

`org-context.txt` is git-ignored, so your internal details stay on your machine and in your project. It is bundled with the deployment and prepended to the system prompt on every request. Prefer the `ORG_CONTEXT` environment variable if you would rather manage it as config than as a file — the variable wins if both are present.

Keep it short. It is sent on every single analysis, so forty lines of high-signal notes beat four hundred lines of data dictionary.

---

## Securing the backend

This is worth reading before you share a URL with your team.

The extension calls the function from a page in the Cloud Console, and a content script cannot attach a Google identity token to that call. So `deploy.sh` deploys with `--allow-unauthenticated`: **anyone who learns the URL can invoke your function**, which means they can spend your Vertex AI budget and use your service account's read access to run dry runs against your tables.

For personal use that is usually an acceptable trade. For anything shared, pick one of these.

The simplest hardening is to keep the URL unguessable and cap the damage. Cloud Functions URLs already include a random component on Gen 2; `--max-instances=5` in `deploy.sh` limits concurrency, and a [billing budget alert](https://cloud.google.com/billing/docs/how-to/budgets) on the project tells you if something is wrong. This does not stop abuse, it just bounds it.

Better is to put the function behind something that authenticates. [Identity-Aware Proxy](https://cloud.google.com/iap/docs/enabling-cloud-run) in front of Cloud Run will restrict invocation to your Google Workspace domain, and because IAP uses a browser cookie rather than a bearer token, it works from the extension — users get a Google sign-in once per session. Deploy with `ALLOW_UNAUTHENTICATED=false ./deploy.sh` and configure IAP on the underlying Cloud Run service.

Alternatively, add a shared secret. Have the function require a header, and have users paste that secret into the options page alongside the URL. This keeps casual passers-by out but the secret is visible in extension storage, so treat it as a speed bump rather than real authentication.

Whichever you choose: the function only ever needs **read** access to BigQuery. Do not run it as a service account with write or admin roles.

## Reading tables in other projects

If your analysts query tables across several projects, the function's service account needs metadata access in each one, or the AI falls back to reasoning without schema information and the advice gets noticeably worse.

```bash
FUNCTION_SA="PROJECT_NUMBER-compute@developer.gserviceaccount.com"

for TARGET in project-a project-b project-c; do
  for ROLE in roles/bigquery.dataViewer roles/bigquery.metadataViewer; do
    gcloud projects add-iam-policy-binding "$TARGET" \
      --member="serviceAccount:${FUNCTION_SA}" --role="$ROLE" --condition=None
  done
done
```

`metadataViewer` alone is enough for schema, partitioning and clustering. Add `dataViewer` only if you also want dry-run estimates to succeed against those projects. Note that the function logs a warning and carries on when metadata is unavailable, so partial access degrades gracefully rather than failing.

## Customizing the audit rules

The checklist lives in `SYSTEM_PROMPT` in `cloud-function/main.py`. It is a plain string, and editing it is the intended way to adapt the tool: add a check for a pattern that bites your team, change the scoring weights, or tighten the wording on a rule the model keeps getting wrong. Redeploy and you are done.

Two things to preserve if you edit it. The response contract at the bottom — the exact JSON shape — is what the extension parses, so keep those field names. And the type-safe filter rules in check 4 are there because the obvious alternative, `TIMESTAMP_SUB`, produces suggestions that fail on `DATE` columns; the `DATE()` wrapper form works for every column type.

If you are adjusting scoring, note that the grade thresholds are also in the prompt, not in code.

---

## Troubleshooting

**The AI Optimize button never appears.** It is deliberately scoped to BigQuery, so check the URL contains `/bigquery`. Reload the tab, and if the toolbar selectors have drifted the button falls back to floating bottom-right — look there before assuming it failed.

**"Not configured yet" in the panel.** The Cloud Function URL is not saved. Open the options page via `chrome://extensions` → Details → Extension options.

**Test connection fails with 401 or 403.** The function is rejecting unauthenticated calls. Either redeploy with `ALLOW_UNAUTHENTICATED=true`, or finish setting up IAP if that was the plan.

**Test connection fails with a network error.** Usually a wrong URL, or a host the extension has not been granted. If your function is behind a custom domain, the options page asks for permission when you save — accept it. Check Cloud Logging for the function to see whether the request arrived at all.

**Analysis returns "Query too short" or finds no query.** The extraction fell through to the visible-DOM strategy and got almost nothing. Click once inside the editor to focus it and try again. Turn on verbose logging to see which of the four strategies is being used.

**The optimized query is identical to the original.** Expected on complex queries — the model is told to preserve correctness over cleverness, and it returns the original rather than risk a wrong rewrite. The Issues tab still has the findings; apply them by hand.

**Suggestions ignore partitioning that definitely exists.** Metadata fetch failed, almost always missing `bigquery.metadataViewer` on the table's project. The function logs the exact error — check Cloud Logging.

**A suggested partition filter fails with a type error.** Report it as an issue with the column type and the generated SQL. Every filter should come out in the `DATE(col) >= DATE_SUB(CURRENT_DATE(), …)` form; if one did not, the prompt needs tightening.

**Analysis times out.** The function's timeout is 120s. Very large queries against many tables can exceed it — raise `--timeout` in `deploy.sh`, up to 540s for Gen 2 HTTP functions.

## Privacy

Your SQL goes to exactly one place: the Cloud Function URL you configure. The extension has no analytics, no telemetry, and no third-party endpoints. It stores two things in Chrome's synced extension storage — that URL and the logging toggle.

Inside your project, your query and the schemas of the tables it references are sent to Vertex AI in the region you chose. Data sent to Vertex AI is [not used to train Google's models](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance). If your organisation restricts where SQL and schema information may be processed, set `VERTEX_LOCATION` to a region inside that boundary.

## Contributing

Issues and pull requests are welcome. The most useful contributions are concrete: a query where the audit missed something obvious, a rewrite that came back syntactically invalid, or a new check with an example of the cost it catches. Prompt improvements are as valuable as code here, and easier to review when they come with a before-and-after.

If you are reporting a bad result, include the query shape (redacted is fine — table names can be `project.dataset.table`), the relevant table's partitioning and clustering, and what you expected instead.

Please do not include real table names, project IDs, or data in issues.

## License

MIT — see [LICENSE](LICENSE). Do what you like with it, including inside your company.
