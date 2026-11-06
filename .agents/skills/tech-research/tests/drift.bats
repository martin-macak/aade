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
