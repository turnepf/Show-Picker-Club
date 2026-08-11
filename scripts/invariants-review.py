#!/usr/bin/env python3
"""Review a PR diff against docs/INVARIANTS.md.

    scripts/invariants-review.py <base-sha> <head-sha> [out-file]

Writes findings to out-file (default review.md), empty when there are none, and
always exits 0 — this is advisory. The deterministic gate is
scripts/check-static.sh plus the ShowPickerCore tests; a reviewer that can be
wrong shouldn't be able to block a merge.

Needs ANTHROPIC_API_KEY. Without it, writes nothing and exits 0, so the
workflow is safe to merge before the secret exists.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MODEL = "claude-opus-5"
# Keep the request bounded — a huge diff is truncated rather than failing.
DIFF_LIMIT = 180_000
# The docs ride along as context, not as the subject of the review.
DOCS_DIFF_LIMIT = 40_000

PROMPT = """You are reviewing a pull request for Show Picker Club against the project's written invariants.

Here are the invariants, verbatim:

<invariants>
{invariants}
</invariants>

Here is the diff{truncated_note}:

<diff>
{diff}
</diff>

The same PR's changes to docs/PRODUCT.md, docs/ARCHITECTURE.md and docs/INVARIANTS.md follow. They are context, not the subject of the review — several invariants (platform parity above all) are satisfied by what the docs say, so check them here before calling one unmet:

<docs_diff>
{docs_diff}
</docs_diff>

Report ONLY concrete violations of the invariants above, or changes that make one materially easier to violate later. For each finding give the file, which rule it breaks, and the specific failure it would cause in production.

Rules for your output:
- Do not restate what the diff does. The author knows.
- Do not raise style, naming, formatting, or test-coverage opinions.
- Do not speculate about code you cannot see in the diff.
- If nothing violates an invariant, reply with exactly: NO FINDINGS
- Otherwise use short markdown bullets, most serious first. Be specific and brief.
"""


def main() -> int:
    out_path = sys.argv[3] if len(sys.argv) > 3 else "review.md"
    open(out_path, "w").close()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set — skipping the invariants review.")
        return 0

    base = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "origin/main"
    head = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "HEAD"

    # The invariants describe Functions, the deployed static files, and the
    # Apple targets. Archived pages aren't worth the tokens.
    diff = subprocess.run(
        [
            "git", "diff", f"{base}...{head}", "--",
            "functions/", "public/", "ios/", "tvos/", "watch/", "ShowPickerCore/",
            ":(exclude)archive/",
        ],
        capture_output=True,
        text=True,
    ).stdout

    if not diff.strip():
        print("No reviewable changes.")
        return 0

    # Rule 7 (platform parity) is satisfied in the docs, not in the code, so a
    # code-only diff made every member-facing PR look like a violation. These
    # two files come along as context — a docs-only PR still isn't reviewed,
    # because the gate above is the code diff.
    docs_diff = subprocess.run(
        [
            "git", "diff", f"{base}...{head}", "--",
            "docs/PRODUCT.md", "docs/ARCHITECTURE.md", "docs/INVARIANTS.md",
        ],
        capture_output=True,
        text=True,
    ).stdout[:DOCS_DIFF_LIMIT].strip() or "(no documentation changes in this PR)"

    truncated = len(diff) > DIFF_LIMIT
    if truncated:
        diff = diff[:DIFF_LIMIT]

    prompt = PROMPT.format(
        invariants=open("docs/INVARIANTS.md").read(),
        diff=diff,
        docs_diff=docs_diff,
        truncated_note=" (TRUNCATED — say so if it matters)" if truncated else "",
    )

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": MODEL,
            "max_tokens": 1500,
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            body = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        # An advisory reviewer that can't reach the API is a no-op, not a
        # failed build.
        print(f"Invariants review unavailable: {exc}")
        return 0

    text = "".join(
        block.get("text", "") for block in body.get("content", [])
    ).strip()

    print(text or "NO FINDINGS")
    if text and text != "NO FINDINGS":
        open(out_path, "w").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
