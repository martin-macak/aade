#!/usr/bin/env bash

# Shepherd a pull request: it carries every item of its issue, proves each
# one, closes every task and triages every review finding before merge.
# The pr-shepherd skill explains the rules and the PR body format.
# Usage: shepherd.sh requirements <issue>
#        shepherd.sh check <pr>
#        shepherd.sh verify <pr>
#        shepherd.sh findings <pr> [--no-advice]
#        shepherd.sh reply <pr> <thread-id|review-id> accepted|rejected --reason <text> [--fix <text>] [--confirmed-by-user]
#        shepherd.sh checks <pr> [--watch]
#        shepherd.sh merge <pr>
#        shepherd.sh disarm <issue>
# requirements prints the R skeleton of an issue. check is deterministic,
# and CI runs it. verify asks decisionkit through decide.sh and writes the
# trace: a commit status and a PR comment. findings lists the untriaged
# review findings. reply triages one finding. checks lists the other PR
# checks that did not pass. merge turns on auto-merge.
# disarm turns off auto-merge on the open PRs that close an edited issue.
# gh picks the repository from the git remote, or from GH_REPO. Run it from
# the repository root. It needs gh, jq and yq, and runs on bash 3.2.
# Exit codes: 0 pass, 1 a rule fails, 2 wrong usage or a failed call.

set -u -o pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
DECIDE=$SKILL_DIR/../decisionkit/scripts/decide.sh
QUESTIONS=$SKILL_DIR/references/questions.yml
CONTEXT=pr-shepherd/trace
MARKER='<!-- pr-shepherd-trace:v1 -->'
WORKFLOW=pr-shepherd.yml
CHECK_NAME=pr-shepherd
NO_ISSUE_LABEL=pr:no-issue
STATUS=0

usage() {
	>&2 sed -nE 's/^# (Usage: |       )shepherd\.sh/shepherd.sh/p' "${BASH_SOURCE[0]}"
	exit 2
}

die() {
	>&2 echo "$1"
	exit 2
}

problem() {
	echo "$1"
	STATUS=1
}

# --- GitHub reads. Each read is one function, so a test stub can serve it.

gh_pr() {
	gh pr view "$1" --json number,body,author,labels,headRefOid,baseRefName,url
}

gh_files() {
	gh api "repos/{owner}/{repo}/pulls/$1/files?per_page=100" --paginate --jq '.[].filename'
}

gh_issue() {
	gh issue view "$1" --json number,title,body
}

# The review threads and the reviews of a PR, as one JSON object. It reads
# one page of 100. It fails when a page is missing, so that the check never
# passes on findings that it did not see.
gh_reviews() {
	local json
	json=$(gh_reviews_page "$1") || return 1
	if jq -e '[.reviewThreads.pageInfo.hasNextPage, .reviews.pageInfo.hasNextPage,
		.reviewThreads.nodes[].comments.pageInfo.hasNextPage] | any' >/dev/null <<<"$json"; then
		>&2 echo "PR #$1 has more than 100 review threads, reviews or thread comments. shepherd.sh reads one page only. Check the rest by hand."
		return 1
	fi
	printf '%s\n' "$json"
}

gh_reviews_page() {
	gh api graphql -F owner='{owner}' -F name='{repo}' -F pr="$1" -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved path line
        comments(first: 100) { pageInfo { hasNextPage } nodes { author { login __typename } body } } } }
      reviews(first: 100) { pageInfo { hasNextPage } nodes { databaseId state body author { login __typename } } }
    }
  }
}' --jq '.data.repository.pullRequest'
}

# The PR comments, as one JSON array.
gh_comments() {
	gh api "repos/{owner}/{repo}/issues/$1/comments?per_page=100" --paginate | jq -s 'add // []'
}

gh_statuses() {
	gh api "repos/{owner}/{repo}/commits/$1/statuses?per_page=100"
}

# The checks of a PR: check runs and commit statuses. gh exits non-zero
# when a check fails or is pending, so only the JSON counts.
gh_checks() {
	local json
	json=$(gh pr checks "$1" --json name,state,bucket,link,workflow 2>/dev/null)
	jq -e 'type == "array"' >/dev/null 2>&1 <<<"$json" || return 1
	printf '%s\n' "$json"
}

gh_rules() {
	gh api "repos/{owner}/{repo}/rules/branches/$1"
}

# --- Text helpers.

# Strip carriage returns, HTML comments and fenced code blocks, so an
# example or a template hint never counts as an item.
clean_body() {
	tr -d '\r' | awk '
		/^[ \t]*```/ { fence = !fence; next }
		fence { next }
		{
			line = $0; out = ""
			while (1) {
				if (inside) {
					i = index(line, "-->")
					if (!i) { line = ""; break }
					line = substr(line, i + 3); inside = 0
				}
				i = index(line, "<!--")
				if (!i) { out = out line; break }
				out = out substr(line, 1, i - 1); line = substr(line, i + 4); inside = 1
			}
			print out
		}'
}

# Collapse each run of white space to one space and trim each line.
normalise() {
	sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

sha8() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c 1-8
}

# Print the items of the "### Done when" or "### Acceptance criteria"
# section of an issue body on stdin, normalised, one per line. An item is
# a top-level list line, with or without a checkbox, plus its indented
# continuation lines. A nested list line or a blank line ends an item.
issue_items() {
	clean_body | awk '
		function flush() { if (cur != "" && cur != "_No response_") print cur; cur = "" }
		/^### / { flush(); inside = ($0 ~ /^### (Done when|Acceptance criteria)[ \t]*$/); next }
		!inside { next }
		/^[-*] / { flush(); cur = $0; sub(/^[-*] (\[[ xX]\] )?/, "", cur); next }
		cur != "" && /^[ \t]+[^ \t]/ && !/^[ \t]+[-*] / { cur = cur " " $0; next }
		{ flush() }
		END { flush() }' | normalise | grep -v '^$'
}

# Print the lines of the "## Requirements" section of a clean body on
# stdin, normalised, without blank lines.
requirements_section() {
	awk '/^## / { inside = ($0 ~ /^## Requirements[ \t]*$/); next } inside' | normalise | grep -v '^$'
}

# Parse the checkbox items of a clean body on stdin. Print one line per
# item: section, indent, tick (x or -), leaf (1 or 0), text and the
# evidence lines, joined by the unit separator. Fields are tab-separated.
parse_items() {
	awk '
		BEGIN { sec = "none" }
		{ gsub(/\t/, "    ") }
		/^## / { sec = substr($0, 4); sub(/[ ]+$/, "", sec); next }
		match($0, /^ *[-*] \[[ xX]\] /) {
			n++; match($0, /^ */); ind[n] = RLENGTH; kind[n] = "C"; s[n] = sec
			tick[n] = (substr($0, RLENGTH + 4, 1) == " ") ? "-" : "x"
			t = substr($0, RLENGTH + 7); gsub(/ +/, " ", t); sub(/^ /, "", t); sub(/ $/, "", t)
			text[n] = t
			next
		}
		match($0, /^ *[-*] evidence:/) {
			n++; match($0, /^ */); ind[n] = RLENGTH; kind[n] = "E"; s[n] = sec
			t = $0; sub(/^ *[-*] evidence:/, "", t); gsub(/ +/, " ", t); sub(/^ /, "", t); sub(/ $/, "", t)
			text[n] = t
		}
		END {
			for (i = 1; i <= n; i++) {
				if (kind[i] != "E") continue
				for (k = i - 1; k >= 1; k--) {
					if (s[k] != s[i]) break
					if (kind[k] == "C" && ind[k] < ind[i]) { ev[k] = ev[k] (ev[k] == "" ? "" : "\037") text[i]; break }
				}
			}
			for (i = 1; i <= n; i++) {
				if (kind[i] != "C") continue
				leaf = 1
				for (j = i + 1; j <= n; j++) {
					if (s[j] != s[i]) break
					if (kind[j] != "C") continue
					if (ind[j] > ind[i]) leaf = 0
					break
				}
				printf "%s\t%d\t%s\t%d\t%s\t%s\n", s[i], ind[i], tick[i], leaf, text[i], ev[i]
			}
		}'
}

# Print the issue number of the first "Closes #<n>" line of a clean body.
closing_issue() {
	sed -nE 's/^(Closes|Fixes|Resolves) #([0-9]+)[[:space:]]*$/\2/p' | head -n 1
}

# Succeed when the PR JSON on stdin is a Dependabot PR.
is_dependabot() {
	jq -e '.author.login | test("^(app/)?dependabot(\\[bot\\])?$")' >/dev/null
}

# Succeed when the PR JSON on stdin has the label $1.
has_label() {
	jq -e --arg l "$1" 'any(.labels[]?; .name == $l)' >/dev/null
}

is_sha() {
	[[ "$1" =~ ^[0-9a-f]{7,40}$ ]]
}

# Check one evidence line $2 of the item $1. $FILES holds the changed paths.
check_evidence() {
	local id=$1 ev=$2 path
	if [[ "$ev" =~ ^https://[^[:space:]]+$ ]] || [[ "$ev" =~ ^\`[^\`]+\`\ -\>\ .+$ ]]; then
		return 0
	fi
	path=${ev#\`}
	path=${path%\`}
	if is_sha "$path"; then
		problem "$id: evidence \"$ev\" is a commit SHA. A rebase changes it. Name a changed path, an https URL or a command with its result."
	elif [[ -n "$path" && "$path" != *' '* ]] && grep -qE '/|\.' <<<"$path"; then
		path=${path#./}
		path=${path%/}
		# A folder counts when the PR changes a file in it.
		if ! awk -v p="$path" '$0 == p || index($0, p "/") == 1 { found = 1 } END { exit !found }' <<<"$FILES"; then
			problem "$id: evidence \"$ev\" is not a path that this PR changes. Name a path from the PR diff."
		fi
	else
		problem "$id: evidence \"$ev\" has no known form. Write a changed path, an https URL or \`command\` -> result."
	fi
}

# Label of an item for a message: its ID, or its text in quotes.
item_label() {
	local text=$1
	if [[ "$text" =~ ^([RV][0-9]+(\.[0-9]+)?)[:\ ] ]]; then
		echo "${BASH_REMATCH[1]}"
	else
		printf '"%s"' "${text:0:60}"
	fi
}

# Check the ticks of every item and the evidence of each ticked leaf in
# Requirements and Verify. $ITEMS holds the output of parse_items.
check_ticks() {
	local sec ind tick leaf text ev label line
	while IFS=$'\t' read -r sec ind tick leaf text ev; do
		[[ -z "$sec" ]] && continue
		label=$(item_label "$text")
		if [[ "$tick" != x ]]; then
			problem "$label: not ticked. Finish the task, then tick it, or remove it."
			continue
		fi
		[[ "$sec" == Requirements || "$sec" == Verify ]] || continue
		((leaf)) || continue
		if [[ -z "$ev" ]]; then
			problem "$label: a ticked leaf needs an \"evidence:\" line below it."
			continue
		fi
		while IFS= read -r line; do
			check_evidence "$label" "$line"
		done < <(tr '\037' '\n' <<<"$ev")
	done <<<"$ITEMS"
}

# Check the R and V items against the issue items in $ISSUE_ITEMS. $1 is
# the issue number. Fill R_TEXTS with the block of each R item, for verify.
check_requirements() {
	local issue=$1 sec ind tick leaf text ev pos=0 want n id sub parent=0 refs ref vcount=0 rcount
	local r_re='^R([0-9]+): (.+)$' s_re='^R([0-9]+)\.([0-9]+): (.+)$' v_re='^V[0-9]+ \((R[0-9]+(, ?R[0-9]+)*)\): .+$'
	local items=()
	R_BLOCKS=()
	R_EVIDENCE=()
	while IFS= read -r want; do
		[[ -n "$want" ]] && items+=("$want")
	done <<<"$ISSUE_ITEMS"
	n=${#items[@]}
	if ((n == 0)); then
		problem "Issue #$issue has no items under \"### Done when\" or \"### Acceptance criteria\". Add them to the issue."
		return
	fi
	if ! grep -q $'^Requirements\t' <<<"$ITEMS"; then
		problem "The body has no R item. Run: shepherd.sh requirements $issue, and paste its output as the \"## Requirements\" section."
	fi
	while IFS=$'\t' read -r sec ind tick leaf text ev; do
		if [[ "$sec" == Requirements ]]; then
			if ((ind == 0)) && [[ "$text" =~ $r_re ]]; then
				id=${BASH_REMATCH[1]}
				pos=$((pos + 1))
				parent=$id
				if ((id != pos)); then
					problem "R$id: expected R$pos at this place. Number the R items R1 to R$n in issue order."
				elif ((pos > n)); then
					problem "R$id: issue #$issue has no item $id. Remove R$id."
				elif [[ "${BASH_REMATCH[2]}" != "${items[pos - 1]}" ]]; then
					problem "R$id: the text differs from item $pos of issue #$issue. Copy it verbatim: ${items[pos - 1]}"
				fi
				R_BLOCKS[pos]="R$id: ${BASH_REMATCH[2]}"
				R_EVIDENCE[pos]=$ev
			elif ((ind > 0)) && [[ "$text" =~ $s_re ]]; then
				sub=${BASH_REMATCH[1]}
				if ((sub != parent)); then
					problem "R$sub.${BASH_REMATCH[2]}: a sub-task of R$parent must be numbered R$parent.<m>."
				fi
				if ((pos > 0)); then
					R_BLOCKS[pos]+=$'\n'"R$sub.${BASH_REMATCH[2]}: ${BASH_REMATCH[3]}"
					[[ -n "$ev" ]] && R_EVIDENCE[pos]+=${R_EVIDENCE[pos]:+$'\037'}$ev
				fi
			else
				problem "Requirements: \"${text:0:60}\" is not an R item. Write \"R<n>: <issue item>\" or, indented, \"R<n>.<m>: <sub-task>\"."
			fi
		elif [[ "$sec" == Verify ]] && ((ind == 0)); then
			if [[ "$text" =~ $v_re ]]; then
				vcount=$((vcount + 1))
				refs=$(sed -E 's/^V[0-9]+ \(([^)]*)\).*/\1/; s/,/ /g' <<<"$text")
				for ref in $refs; do
					[[ " $(all_rids) " == *" $ref "* ]] ||
						problem "$(item_label "$text"): $ref is not an R item of this PR."
				done
			else
				problem "Verify: \"${text:0:60}\" is not a V item. Write \"V<n> (R<k>): <check>\"."
			fi
		fi
	done <<<"$ITEMS"
	rcount=$pos
	for ((want = rcount + 1; want <= n; want++)); do
		problem "R$want is missing. Add it: - [ ] R$want: ${items[want - 1]}"
	done
	((vcount > 0)) || problem "Verify: the PR has no V item. Add at least one: - [ ] V1 (R1): <check>"
}

# Print the IDs of all top R items in $ITEMS, so a V item may name a later R.
all_rids() {
	awk -F '\t' '$1 == "Requirements" && $2 == 0 && $5 ~ /^R[0-9]+: / { sub(/:.*/, "", $5); printf " %s", $5 }' <<<"$ITEMS"
}

# Check the trace status of the head SHA $1 against the hashes $2 and $3.
check_trace() {
	local sha=$1 req=$2 issue_hash=$3 issue=$4 pr=$5 json state desc url
	json=$(gh_statuses "$sha") || die "Cannot read the statuses of $sha."
	json=$(jq -c --arg c "$CONTEXT" '[.[] | select(.context == $c)][0] // empty' <<<"$json")
	if [[ -z "$json" ]]; then
		problem "Trace: no $CONTEXT status on ${sha:0:8}. Run: shepherd.sh verify $pr"
		return
	fi
	state=$(jq -r '.state' <<<"$json")
	desc=$(jq -r '.description // ""' <<<"$json")
	url=$(jq -r '.target_url // ""' <<<"$json")
	if [[ "$state" != success ]]; then
		problem "Trace: the $CONTEXT status is $state. Read $url, fix the items, then run: shepherd.sh verify $pr"
	fi
	[[ "$desc" == *"req=$req"* ]] ||
		problem "Trace: the Requirements section changed after verify. Run: shepherd.sh verify $pr"
	[[ "$desc" == *"issue=$issue_hash"* ]] ||
		problem "Trace: issue #$issue changed after verify. Run: shepherd.sh verify $pr"
}

# jq definitions shared by check, findings and reply.
JQ_DEFS='
def kind: if (.__typename == "Bot") or ((.login // "") | endswith("[bot]")) then "bot" else "human" end;
def who: (.author // {login: "ghost", __typename: "User"});
def triage:
	[ .[] | (split("\n") | map(sub("\r$"; ""))) as $l
	| select(any($l[]; test("^triage: (accepted|rejected)$")))
	| { verdict: ([$l[] | select(test("^triage: "))][0] | sub("^triage: "; "")),
	    fix: (([$l[] | select(test("^fix: "))][0] // "fix: ") | sub("^fix: "; "") | sub("^ +"; "")),
	    confirmed: any($l[]; . == "confirmed-by-user: yes") } ] | last;
def triage_problems($what; $kind):
	if . == null then empty
	elif .verdict == "accepted" and (.fix | length) == 0 then
		"\($what): the accepted triage has no \"fix:\" line. Fix the finding, then reply again with --fix."
	elif .verdict == "accepted" and (.fix | test("^[0-9a-f]{7,40}$")) then
		"\($what): \"fix:\" names a commit SHA. A rebase changes it. Name the changed path or the change."
	elif .verdict == "rejected" and $kind == "human" and (.confirmed | not) then
		"\($what): a rejection of a human finding needs \"confirmed-by-user: yes\". Ask the user first."
	else empty end;
def threads:
	[ .reviewThreads.nodes[]
	| (.comments.nodes[0] | who) as $a
	| { id, resolved: .isResolved, path, line, author: $a.login, kind: ($a | kind),
	    text: (.comments.nodes[0].body // ""),
	    triage: ([.comments.nodes[1:][].body] | triage) } ];
def review_bodies($comments):
	[ .reviews.nodes[]
	| select(.state != "APPROVED" and ((.body // "") | test("[^[:space:]]")))
	| (who) as $a
	| (.databaseId | tostring) as $id
	| { id: $id, author: $a.login, kind: ($a | kind), text: .body,
	    triage: ([$comments[] | .body // "" | select(split("\n") | map(sub("\r$"; "")) | any(. == "review: \($id)"))] | triage) } ];
'

# Check the review threads and the reviews of the PR $1.
check_reviews() {
	local pr=$1 reviews comments line
	reviews=$(gh_reviews "$pr") || die "Cannot read the reviews of PR #$pr."
	comments=$(gh_comments "$pr") || die "Cannot read the comments of PR #$pr."
	while IFS= read -r line; do
		[[ -n "$line" ]] && problem "$line"
	done < <(jq -r --argjson comments "$comments" --arg pr "$pr" "$JQ_DEFS"'
		(threads[]
		| "Thread \(.id) (\(.author))" as $w
		| if .triage == null then
			"\($w): not triaged. Run: shepherd.sh reply \($pr) \(.id) accepted|rejected --reason <text>"
		  else (.kind as $k | .triage | triage_problems($w; $k)),
			(if .resolved then empty else "\($w): triaged, but not resolved. Resolve the thread." end)
		  end),
		(review_bodies($comments)[]
		| "Review \(.id) (\(.author))" as $w
		| if .triage == null then
			"\($w): the review body is not triaged. Run: shepherd.sh reply \($pr) \(.id) accepted|rejected --reason <text>"
		  else (.kind as $k | .triage | triage_problems($w; $k)) end),
		([.reviews.nodes[] | select(.state != "COMMENTED" and .state != "PENDING")]
		| group_by(.author.login // "ghost")[] | last
		| select(.state == "CHANGES_REQUESTED")
		| "Review \(.databaseId) (\(.author.login // "ghost")): changes requested. Address the findings, then ask \(.author.login // "ghost") to approve or dismiss the review.")
		' <<<"$reviews")
}

# Load the PR $1 into PR_JSON, BODY, SHA and BASE_REF.
load_pr() {
	PR_JSON=$(gh_pr "$1") || die "Cannot read PR #$1."
	BODY=$(jq -r '.body // ""' <<<"$PR_JSON" | clean_body)
	SHA=$(jq -r '.headRefOid' <<<"$PR_JSON")
	BASE_REF=$(jq -r '.baseRefName' <<<"$PR_JSON")
}

# Load the issue $1 into ISSUE_ITEMS and ISSUE_HASH.
load_issue() {
	local json
	json=$(gh_issue "$1") || die "Cannot read issue #$1."
	ISSUE_ITEMS=$(jq -r '.body // ""' <<<"$json" | issue_items)
	ISSUE_HASH=$(printf '%s\n' "$ISSUE_ITEMS" | sha8)
}

# Run every deterministic rule on the PR $1. Print one problem per line.
run_check() {
	local pr=$1 issue req
	load_pr "$pr"
	if is_dependabot <<<"$PR_JSON"; then
		echo "PR #$pr is a Dependabot PR. It is exempt."
		return 0
	fi
	FILES=$(gh_files "$pr") || die "Cannot read the files of PR #$pr."
	ITEMS=$(parse_items <<<"$BODY")
	check_ticks
	if has_label "$NO_ISSUE_LABEL" <<<"$PR_JSON"; then
		echo "PR #$pr has the label $NO_ISSUE_LABEL. It needs no issue items and no trace."
	else
		issue=$(closing_issue <<<"$BODY")
		if [[ -z "$issue" ]]; then
			problem "The body has no \"Closes #<issue>\" line. Add it, or add the label $NO_ISSUE_LABEL."
		else
			load_issue "$issue"
			check_requirements "$issue"
			req=$(requirements_section <<<"$BODY" | sha8)
			[[ -n "$ISSUE_ITEMS" ]] && check_trace "$SHA" "$req" "$ISSUE_HASH" "$issue" "$pr"
		fi
	fi
	check_reviews "$pr"
	return "$STATUS"
}

cmd_check() {
	(($# == 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	if run_check "$1"; then
		echo "PR #$1 passes every shepherd rule."
		return 0
	fi
	return 1
}

cmd_requirements() {
	local n=0 item
	(($# == 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	load_issue "$1"
	if [[ -z "$ISSUE_ITEMS" ]]; then
		>&2 echo "Issue #$1 has no items under \"### Done when\" or \"### Acceptance criteria\". Add them to the issue."
		return 1
	fi
	printf '## Requirements\n\n'
	while IFS= read -r item; do
		n=$((n + 1))
		printf -- '- [ ] R%d: %s\n' "$n" "$item"
	done <<<"$ISSUE_ITEMS"
}

# Ask the question $1 of the questions file with the context $2. Print
# "<answer> <p> <uncertain>". Exit 2 when decide.sh fails.
ask() {
	local line rc
	line=$("$DECIDE" ask "$QUESTIONS" "$1" --context "$2")
	rc=$?
	((rc > 1)) && return 2
	jq -r '"\(.answer) \(.p) \(.uncertain)"' <<<"$line"
}

# Format one verdict cell from "<answer> <p> <uncertain>". A false answer
# fails the trace. An uncertain true answer passes, but the agent must
# sharpen the item or decide itself, as the skill says.
cell() {
	local answer=$1 p=$2 uncertain=$3
	if [[ "$answer" == true && "$uncertain" == false ]]; then
		printf 'ok %s' "$p"
	elif [[ "$answer" == true ]]; then
		printf 'uncertain %s' "$p"
	else
		printf 'FAIL %s' "$p"
	fi
}

# Wait for the newest pr-shepherd run on the head SHA, then re-run it, so
# it reads the new trace. A status or a resolved thread fires no workflow.
rerun_ci() {
	local run id state
	run=$(gh run list --workflow "$WORKFLOW" --commit "$SHA" --limit 1 --json databaseId,status \
		--jq '.[0] | "\(.databaseId) \(.status)"' 2>/dev/null)
	if [[ -z "$run" || "$run" == "null null" ]]; then
		echo "No $CHECK_NAME run on ${SHA:0:8} yet. The next run reads the trace."
		return 0
	fi
	id=${run%% *}
	state=${run#* }
	if [[ "$state" != completed ]]; then
		echo "Waiting for run $id to end."
		gh run watch "$id" >/dev/null 2>&1 || true
	fi
	if gh run rerun "$id" >/dev/null 2>&1; then
		echo "Re-ran run $id."
	else
		echo "Could not re-run run $id. Re-run it in the Actions tab."
	fi
}

cmd_verify() {
	local pr issue req n i carry evid subs table="" verdict url comments id body problems
	(($# == 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	pr=$1
	load_pr "$pr"
	if is_dependabot <<<"$PR_JSON" || has_label "$NO_ISSUE_LABEL" <<<"$PR_JSON"; then
		echo "PR #$pr is exempt. It needs no trace."
		return 0
	fi
	issue=$(closing_issue <<<"$BODY")
	[[ -n "$issue" ]] || {
		echo "The body has no \"Closes #<issue>\" line. Add it, or add the label $NO_ISSUE_LABEL."
		return 1
	}
	load_issue "$issue"
	ITEMS=$(parse_items <<<"$BODY")
	problems=$(check_requirements "$issue")
	if [[ -n "$problems" ]]; then
		echo "$problems"
		echo "Fix the R and V items first. verify wrote no trace."
		return 1
	fi
	# check_requirements ran in a subshell above. Run it again for R_BLOCKS.
	check_requirements "$issue" >/dev/null
	n=${#R_BLOCKS[@]}
	PASS=1
	for ((i = 1; i <= n; i++)); do
		subs=$(sed -nE '2,$ s/^R[0-9]+\.[0-9]+: /- /p' <<<"${R_BLOCKS[i]}")
		carry=$(ask carryover "$(printf 'Issue item:\n%s\n\nSub-tasks of the PR item:\n%s\n' \
			"$(sed -n "${i}p" <<<"$ISSUE_ITEMS")" "${subs:-(none)}")") || die "decisionkit failed. Run: decisionkit status"
		if [[ -n "${R_EVIDENCE[i]:-}" ]]; then
			evid=$(ask evidence "$(printf 'Claim:\n%s\n\nEvidence:\n%s\n' "${R_BLOCKS[i]}" \
				"$(tr '\037' '\n' <<<"${R_EVIDENCE[i]}")")") || die "decisionkit failed. Run: decisionkit status"
		else
			evid="none - false"
		fi
		# shellcheck disable=SC2086 # each answer splits into its 3 words.
		carry=$(cell $carry)
		# shellcheck disable=SC2086
		evid=$(cell $evid)
		[[ "$carry" == FAIL* || "$evid" == FAIL* ]] && PASS=0
		table+="| R$i | $carry | $evid |"$'\n'
	done
	req=$(requirements_section <<<"$BODY" | sha8)
	verdict=failure
	((PASS)) && verdict=success
	body=$(printf '%s\n## pr-shepherd trace\n\nHead `%s`, Requirements `%s`, issue #%s `%s`.\n\n| Item | Carry-over | Evidence |\n| --- | --- | --- |\n%s\nVerdict: **%s**. ' \
		"$MARKER" "${SHA:0:8}" "$req" "$issue" "$ISSUE_HASH" "$table" "$verdict")
	if [[ "$verdict" == success ]]; then
		body+="Every R item carries its issue item, and its evidence supports it. Sharpen each uncertain row, or state in the PR why it holds."
	else
		body+="Fix each FAIL row: add the missing sub-tasks or better evidence. Then run \`shepherd.sh verify $pr\` again."
	fi
	comments=$(gh_comments "$pr") || die "Cannot read the comments of PR #$pr."
	id=$(jq -r --arg m "$MARKER" '[.[] | select((.body // "") | startswith($m))][0].id // empty' <<<"$comments")
	if [[ -n "$id" ]]; then
		url=$(gh api -X PATCH "repos/{owner}/{repo}/issues/comments/$id" -f body="$body" --jq .html_url) ||
			die "Cannot update the trace comment $id."
	else
		url=$(gh api "repos/{owner}/{repo}/issues/$pr/comments" -f body="$body" --jq .html_url) ||
			die "Cannot write the trace comment."
	fi
	gh api "repos/{owner}/{repo}/statuses/$SHA" -f state="$verdict" -f context="$CONTEXT" \
		-f description="req=$req issue=$ISSUE_HASH" -f target_url="$url" --silent ||
		die "Cannot write the $CONTEXT status."
	printf '%s' "$table"
	echo "Trace: $verdict on ${SHA:0:8}. $url"
	rerun_ci
	[[ "$verdict" == success ]]
}

cmd_findings() {
	local pr reviews comments advice=1 line text valid severity
	(($# >= 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	pr=$1
	[[ "${2:-}" == --no-advice ]] && advice=0
	reviews=$(gh_reviews "$pr") || die "Cannot read the reviews of PR #$pr."
	comments=$(gh_comments "$pr") || die "Cannot read the comments of PR #$pr."
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		if ((advice)); then
			text=$(jq -r '"Finding on \(.path // "the PR"):\n\(.text)"' <<<"$line")
			valid=$("$DECIDE" ask "$QUESTIONS" finding-valid --context "$text")
			(($? > 1)) && die "decisionkit failed. Run: decisionkit status"
			severity=$("$DECIDE" ask "$QUESTIONS" finding-severity --context "$text")
			(($? > 1)) && die "decisionkit failed. Run: decisionkit status"
			line=$(jq -c --argjson v "$valid" --argjson s "$severity" \
				'. + {valid: {answer: $v.answer, p: $v.p, uncertain: $v.uncertain},
				severity: {answer: $s.answer, expected: $s.expected, uncertain: $s.uncertain}}' <<<"$line")
		fi
		echo "$line"
	done < <(jq -c --argjson comments "$comments" "$JQ_DEFS"'
		(threads[] | select(.triage == null) | {target: .id, type: "thread", author, kind, path, line, text}),
		(review_bodies($comments)[] | select(.triage == null) | {target: .id, type: "review", author, kind, path: null, line: null, text})
		' <<<"$reviews")
}

cmd_reply() {
	local pr target verdict reason="" fix="" confirmed=0 reviews kind body
	(($# >= 3)) || usage
	pr=$1 target=$2 verdict=$3
	shift 3
	[[ "$pr" =~ ^[0-9]+$ ]] || usage
	[[ "$verdict" == accepted || "$verdict" == rejected ]] || usage
	while (($# > 0)); do
		case $1 in
		--reason)
			(($# >= 2)) || usage
			reason=$2
			shift 2
			;;
		--fix)
			(($# >= 2)) || usage
			fix=$2
			shift 2
			;;
		--confirmed-by-user)
			confirmed=1
			shift
			;;
		*) usage ;;
		esac
	done
	reason=$(tr '\n' ' ' <<<"$reason" | normalise)
	fix=$(tr '\n' ' ' <<<"$fix" | normalise)
	[[ -n "$reason" ]] || die "Give a reason with --reason."
	if [[ "$verdict" == accepted ]]; then
		[[ -n "$fix" ]] || die "An accepted finding needs --fix: the changed path or the change."
		is_sha "$fix" && die "--fix names a commit SHA. A rebase changes it. Name the changed path or the change."
	fi
	reviews=$(gh_reviews "$pr") || die "Cannot read the reviews of PR #$pr."
	if [[ "$target" =~ ^[0-9]+$ ]]; then
		kind=$(jq -r --arg id "$target" "$JQ_DEFS"'[.reviews.nodes[] | select((.databaseId | tostring) == $id) | who | kind][0] // empty' <<<"$reviews")
	else
		kind=$(jq -r --arg id "$target" "$JQ_DEFS"'[threads[] | select(.id == $id) | .kind][0] // empty' <<<"$reviews")
	fi
	[[ -n "$kind" ]] || die "PR #$pr has no review thread or review $target."
	if [[ "$verdict" == rejected && "$kind" == human ]] && ((!confirmed)); then
		echo "A human wrote this finding. Ask the user to confirm the rejection, then add --confirmed-by-user."
		return 1
	fi
	body=""
	[[ "$target" =~ ^[0-9]+$ ]] && body="review: $target"$'\n'
	body+="triage: $verdict"$'\n'"reason: $reason"
	[[ -n "$fix" ]] && body+=$'\n'"fix: $fix"
	((confirmed)) && body+=$'\n'"confirmed-by-user: yes"
	if [[ "$target" =~ ^[0-9]+$ ]]; then
		gh api "repos/{owner}/{repo}/issues/$pr/comments" -f body="$body" --silent || die "Cannot write the triage comment."
		echo "Triaged review $target as $verdict."
		return 0
	fi
	gh api graphql -f id="$target" -f body="$body" -f query='
mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } }
}' --silent || die "Cannot reply to thread $target."
	gh api graphql -f id="$target" -f query='
mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' --silent ||
		die "Cannot resolve thread $target."
	echo "Triaged thread $target as $verdict, and resolved it."
}

# Print one problem for each check of the PR $1 that did not pass. The
# check itself and the trace are left out, because check covers them.
run_checks() {
	local pr=$1 json line
	json=$(gh_checks "$pr") || die "Cannot read the checks of PR #$pr."
	while IFS= read -r line; do
		[[ -n "$line" ]] && problem "$line"
	done < <(jq -r --arg self "$CHECK_NAME" --arg trace "$CONTEXT" --arg pr "$pr" '
		.[] | select(.name != $self and .name != $trace)
		| (if (.workflow // "") == "" then .name else "\(.workflow)/\(.name)" end) as $n
		| ((.link // "") | if test("/actions/runs/[0-9]+/") then capture("/actions/runs/(?<id>[0-9]+)/").id else null end) as $run
		| if .bucket == "fail" then
			"Check \($n): failed. " + (if $run then "Read: gh run view \($run) --log-failed" else "Read \(.link)" end) + ". Fix the cause, push, then run a new pass."
		  elif .bucket == "pending" then
			"Check \($n): still running. Run: shepherd.sh checks \($pr) --watch"
		  elif .bucket == "cancel" then
			"Check \($n): cancelled. Re-run it" + (if $run then ": gh run rerun \($run)" else "" end) + "."
		  else empty end' <<<"$json")
	return "$STATUS"
}

cmd_checks() {
	(($# >= 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	if [[ "${2:-}" == --watch ]]; then
		gh pr checks "$1" --watch >/dev/null 2>&1 || true
	elif (($# > 1)); then
		usage
	fi
	if run_checks "$1"; then
		echo "Every other check of PR #$1 passed."
		return 0
	fi
	return 1
}

cmd_merge() {
	local pr rules
	(($# == 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	pr=$1
	if ! run_check "$pr" || ! run_checks "$pr"; then
		echo "Fix the problems above before merge."
		return 1
	fi
	rules=$(gh_rules "$BASE_REF") || die "Cannot read the rules of $BASE_REF."
	if ! jq -e --arg c "$CHECK_NAME" 'any(.[]; .type == "required_status_checks"
		and any(.parameters.required_status_checks[]?; .context == $c))' <<<"$rules" >/dev/null; then
		echo "The rules of $BASE_REF do not require the $CHECK_NAME check, so auto-merge could skip it. Ask an admin to add it to the ruleset."
		return 1
	fi
	# Squash, not rebase: the ruleset requires signed commits, and GitHub
	# signs a squash commit but cannot sign the commits of a rebase merge.
	# A squash still keeps the history linear.
	gh pr merge "$pr" --auto --squash || die "Cannot turn on auto-merge for PR #$pr."
	echo "Auto-merge is on for PR #$pr. GitHub merges it when every required check passes."
}

cmd_disarm() {
	local issue prs pr
	(($# == 1)) && [[ "$1" =~ ^[0-9]+$ ]] || usage
	issue=$1
	prs=$(gh api graphql -F owner='{owner}' -F name='{repo}' -F issue="$issue" -f query='
query($owner: String!, $name: String!, $issue: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $issue) {
    closedByPullRequestsReferences(first: 50, includeClosedPrs: false) { nodes { number autoMergeRequest { enabledAt } } } } }
}' --jq '.data.repository.issue.closedByPullRequestsReferences.nodes[] | select(.autoMergeRequest != null) | .number') ||
		die "Cannot read the PRs that close issue #$issue."
	if [[ -z "$prs" ]]; then
		echo "No open PR with auto-merge closes issue #$issue."
		return 0
	fi
	for pr in $prs; do
		if gh pr merge "$pr" --disable-auto >/dev/null 2>&1; then
			echo "PR #$pr: auto-merge is off, because issue #$issue changed. Run shepherd.sh verify $pr again."
		else
			echo "PR #$pr: could not turn off auto-merge."
			STATUS=1
		fi
	done
	return "$STATUS"
}

# A test can source this file to use the functions.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

(($# >= 1)) || usage
cmd=$1
shift
case $cmd in
requirements) cmd_requirements "$@" ;;
check) cmd_check "$@" ;;
verify) cmd_verify "$@" ;;
findings) cmd_findings "$@" ;;
reply) cmd_reply "$@" ;;
checks) cmd_checks "$@" ;;
merge) cmd_merge "$@" ;;
disarm) cmd_disarm "$@" ;;
*) usage ;;
esac
