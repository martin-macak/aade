#!/usr/bin/env bats

# Drift tests for the tech-research skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	DIR="$ROOT/.agents/skills/tech-research"
	SKILL="$DIR/SKILL.md"
	TYPES="$DIR/references/types.yml"
	SCRIPT="$DIR/scripts/research.sh"
	CONFIG="$ROOT/.pre-commit-config.yaml"
	MISE="$ROOT/mise.toml"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
}

yes_no() { [[ "$1" == true ]] && echo yes || echo no; }

@test "the folder, the front matter name and the Claude Code path agree" {
	dir=$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)
	[ "$(yq --front-matter=extract '.name' "$SKILL")" = "$(basename "$dir")" ]
	[ "$(cd "$ROOT/.claude/skills/$(basename "$dir")" && pwd -P)" = "$dir" ]
}

@test "the types table matches types.yml" {
	listed=$(sed -nE 's/^\| `([a-z-]+)` \| (yes|no) \| (yes|no) \| (yes|no) \|.*/\1 \2 \3 \4/p' "$SKILL")
	expected=$(for type in $(yq 'keys | .[]' "$TYPES"); do
		echo "$type $(yes_no "$(yq ".[\"$type\"].required" "$TYPES")") $(yes_no "$(yq ".[\"$type\"].repeatable" "$TYPES")") $(yes_no "$(yq ".[\"$type\"].diagram" "$TYPES")")"
	done)
	diff <(echo "$listed") <(echo "$expected")
}

@test "each type has a template with the common front matter, and nothing else has one" {
	templates=$(cd "$DIR/references/templates" && ls -- *.md | sed 's/\.md$//' | sort)
	diff <(echo "$templates") <(yq 'keys | .[]' "$TYPES" | sort)
	for type in $templates; do
		f="$DIR/references/templates/$type.md"
		[ "$(yq --front-matter=extract '.type' "$f")" = "$type" ]
		[ "$(yq --front-matter=extract '.status' "$f")" = draft ]
		for key in title created updated authors; do
			yq --front-matter=extract -e "has(\"$key\")" "$f" >/dev/null
		done
		grep -qx '# Title' "$f"
	done
}

@test "the statuses, kinds and depths in the skill match the script" {
	for var in STATUSES KINDS DEPTHS; do
		values=$(sed -nE "s/^$var=\"(.*)\"$/\1/p" "$SCRIPT")
		[ -n "$values" ]
		for value in $values; do
			[[ "$TEXT" == *"\`$value\`"* ]] || {
				echo "SKILL.md does not name the $var value $value."
				return 1
			}
		done
	done
}

@test "every command in the skill exists in the script" {
	for cmd in $(grep -oE '\$R [a-z]+' "$SKILL" | awk '{ print $2 }' | sort -u); do
		grep -qE "^$cmd\) cmd_" "$SCRIPT" || {
			echo "SKILL.md uses \$R $cmd, but research.sh has no such command."
			return 1
		}
	done
}

@test "the mise task runs the check, and mise run check runs the task" {
	run_line=$(yq -p toml '.tasks["research:check"].run' "$MISE")
	[ "$run_line" = ".agents/skills/tech-research/scripts/research.sh check" ]
	yq -p toml '.tasks.check.depends[]' "$MISE" | grep -qx research:check
	[[ "$TEXT" == *'mise run research:check'* ]] || false
}

@test "the research-check hook runs the task on docs/research" {
	hook='.repos[].hooks[] | select(.id == "research-check")'
	[ "$(yq "$hook | .entry" "$CONFIG")" = "mise run research:check" ]
	[ "$(yq "$hook | .files" "$CONFIG")" = "^docs/research/" ]
	[[ "$TEXT" == *'pre-commit hook `research-check`'* ]] || false
}

@test "every command of the script appears in the skill" {
	for cmd in $(sed -nE 's/^([a-z]+)\) cmd_.*/\1/p' "$SCRIPT"); do
		grep -qE "\\\$R $cmd( |\`|$)" "$SKILL" || {
			echo "research.sh has the command $cmd, but SKILL.md never shows \$R $cmd."
			return 1
		}
	done
}

@test "the usage block lists exactly the commands of the script" {
	usage=$(sed -nE 's/^#   research\.sh ([a-z]+).*/\1/p' "$SCRIPT" | sort -u)
	commands=$(sed -nE 's/^([a-z]+)\) cmd_.*/\1/p' "$SCRIPT" | sort -u)
	diff <(echo "$usage") <(echo "$commands")
}

@test "sub-slugs go one level deep in the skill and in the script" {
	re=$(sed -nE "s/^SLUG_PATH_RE='(.*)'$/\1/p" "$SCRIPT")
	[ -n "$re" ]
	[[ "a-b" =~ $re ]] || false
	[[ "a-b/c-d" =~ $re ]] || false
	[[ ! "a/b/c" =~ $re ]] || false
	[[ ! "a/" =~ $re ]] || false
	[[ "$TEXT" == *'`docs/research/<slug>/<sub-slug>/`'* ]] || false
	[[ "$TEXT" == *'**One level.**'* ]] || false
}

@test "the status diagram matches the moves of status, and only reopen moves final to draft" {
	diagram=$(awk '/^stateDiagram-v2/ { on = 1; next } on && /^```/ { exit } on' "$SKILL")
	moves=$(grep -vE '\[\*\]|:' <<<"$diagram" | sed -nE 's/^ *([a-z]+) --> ([a-z]+) *$/\1>\2/p' | sort)
	allowed=$(sed -nE 's/^\t"draft>review" \| (.*)\) ;;$/"draft>review" | \1/p' "$SCRIPT" | tr -d '" ' | tr '|' '\n' | sort)
	[ -n "$allowed" ]
	diff <(echo "$moves") <(echo "$allowed")
	grep -qE '^ *final --> draft: reopen$' <<<"$diagram"
	grep -qE '^reopen\) cmd_reopen' "$SCRIPT"
}

# The value of the one-line variable $1 of research.sh.
script_var() { sed -nE "s/^$1=\"(.*)\"$/\1/p" "$SCRIPT"; }

@test "the Research issue form has the fields that init --issue reads, and the same values" {
	FORM="$ROOT/.github/ISSUE_TEMPLATE/research.yml"
	[ "$(yq '.labels | join(",")' "$FORM")" = "$(script_var ISSUE_LABEL)" ]
	# issue_section of research.sh names the Scope label of every form.
	[ "$(yq '.body[] | select(.id == "scope") | .attributes.label' "$FORM")" = Scope ]
	sections=$(script_var ISSUE_SECTIONS | tr ';' '\n')
	[ -n "$sections" ]
	expected=$( (cut -d= -f1 <<<"$sections"; script_var ISSUE_DEPTH; script_var ISSUE_ARTIFACTS; script_var ISSUE_SLUG) | sort)
	diff <(yq '.body[] | select(.id != "scope") | .attributes.label' "$FORM" | sort) <(echo "$expected")
	while IFS= read -r heading; do
		grep -qxF -- "$heading" "$DIR/references/templates/brief.md" || {
			echo "The brief template has no heading '$heading'."
			return 1
		}
	done < <(cut -d= -f2 <<<"$sections")
	depth=$(script_var ISSUE_DEPTH)
	[ "$(yq ".body[] | select(.attributes.label == \"$depth\") | .attributes.options | join(\" \")" "$FORM")" = "$(script_var DEPTHS)" ]
	artifacts=$(script_var ISSUE_ARTIFACTS)
	diff <(yq ".body[] | select(.attributes.label == \"$artifacts\") | .attributes.options[].label" "$FORM") \
		<(yq 'to_entries | .[] | select(.value.required == false) | .key' "$TYPES")
}

@test "the skill names init --issue and the label of a research issue" {
	[[ "$TEXT" == *"--issue <n>"* ]] || false
	[[ "$TEXT" == *"\`$(script_var ISSUE_LABEL)\`"* ]] || false
	for field in "$(script_var ISSUE_DEPTH)" "$(script_var ISSUE_ARTIFACTS)" "$(script_var ISSUE_SLUG)"; do
		[[ "$TEXT" == *"$field"* ]] || false
	done
}
