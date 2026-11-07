#!/usr/bin/env bats

# Drift tests for the library-docs skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	SKILL="$ROOT/.agents/skills/library-docs/SKILL.md"
	CURATOR="$ROOT/.agents/skills/knowledge-curator/SKILL.md"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
	DESCRIPTION=$(yq --front-matter=extract '.description' "$SKILL")
}

@test "the folder, the front matter name and the Claude Code path agree" {
	dir=$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)
	[ "$(yq --front-matter=extract '.name' "$SKILL")" = "$(basename "$dir")" ]
	# .claude/skills links to the whole .agents/skills folder.
	[ "$(cd "$ROOT/.claude/skills/$(basename "$dir")" && pwd -P)" = "$dir" ]
}

@test "the description names Context7 and the workflow names its two tools in call order" {
	[[ "$DESCRIPTION" == *"Context7"* ]] || false
	[[ "$TEXT" == *"\`resolve-library-id\`"*"\`query-docs\`"* ]] || false
	[[ "$TEXT" == *"\`/org/project\`"* ]] || false
}

@test "only this skill holds the Context7 workflow, and nothing uses the retired tool name" {
	# Context7 renamed get-library-docs to query-docs. The other skills and
	# docs must not repeat the workflow, because a fact lives in one place.
	! grep -q 'get-library-docs' "$SKILL" || false
	others=$(git -C "$ROOT" grep -lE 'resolve-library-id|query-docs|get-library-docs' -- . ':!.agents/skills/library-docs' || true)
	[ -z "$others" ] || {
		echo "These files repeat the Context7 tool names: $others"
		return 1
	}
}

@test "each tool that the description names is part of this repository" {
	list=$(sed -nE 's/.*\(([^)]*)\).*/\1/p' <<<"$DESCRIPTION" | sed 's/ and others$//' | tr ',' '\n' | sed 's/^ *//')
	[ -n "$list" ]
	while IFS= read -r lib; do
		case $lib in
		mise) [ -f "$ROOT/mise.toml" ] ;;
		pre-commit) grep -qE '^pre-commit = "[0-9]' "$ROOT/mise.toml" ;;
		Vale) grep -qE '^vale = "[0-9]' "$ROOT/mise.toml" ;;
		bats) grep -qE '^bats = "[0-9]' "$ROOT/mise.toml" ;;
		"GitHub Actions") compgen -G "$ROOT/.github/workflows/*.yml" >/dev/null ;;
		*)
			echo "The description names $lib, but this test has no check for it."
			return 1
			;;
		esac || {
			echo "The description names $lib, but the repository does not use it."
			return 1
		}
	done <<<"$list"
}

@test "mise.toml pins each tool to an exact version, so a version-specific ID has one target" {
	# The workflow says to use a version-specific ID when the repository pins
	# a version. A loose pin such as "1.8" has no single target.
	loose=$(yq -p toml -o json '.tools' "$ROOT/mise.toml" |
		jq -r 'to_entries[] | select(((.value | if type == "object" then .version else . end) | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) | not) | .key')
	[ -z "$loose" ] || {
		echo "These tools have no exact version: $loose"
		return 1
	}
	[[ "$TEXT" == *"Use a version-specific ID when the repository pins a version."* ]] || false
}

@test "the knowledge curator still names this skill and Context7" {
	grep -qF '`library-docs`' "$CURATOR"
	grep -E '^\| `library-docs` \|' "$CURATOR" | grep -q 'Context7'
}
