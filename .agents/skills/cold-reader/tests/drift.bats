#!/usr/bin/env bats

# Drift tests for the cold-reader skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here. decisionkit is not
# in CI, so each test that runs it skips when it is missing.
# List every path outside the skill that a test reads in drift.watch.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	DIR="$ROOT/.agents/skills/cold-reader"
	SKILL="$DIR/SKILL.md"
	CALIBRATE="$DIR/scripts/calibrate.sh"
	FIXTURES="$DIR/references/fixtures"
	RUNNER="$ROOT/.agents/skills/knowledge-curator/scripts/test-skill.sh"
	SKILL_MK="$ROOT/.agents/skills/knowledge-curator/scripts/skill.mk"
	MISE="$ROOT/mise.toml"
	VALE_INI="$ROOT/.vale.ini"
	HOOKS="$ROOT/.pre-commit-config.yaml"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
}

# Print the lines of the "## <name>" section of SKILL.md.
section() {
	awk -v head="## $1" '$0 == head { inside = 1; next } inside && /^## / { exit } inside' "$SKILL"
}

# Print the lines of the fenced block "```sh questions".
questions_block() {
	awk '/^```sh questions$/ { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL"
}

# Set Q_MATCH, MATCH_MIN, Q_SLOP and SLOP_MAX, as calibrate.sh does.
load_questions() {
	eval "$(questions_block)"
}

# Succeed when $1 < $2. awk does the float compare, because bash has none.
less_than() {
	awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'
}

# Print the flags of the "claude -p" command in SKILL.md, one per line.
claude_flags() {
	awk '/claude -p/ { inside = 1 } inside { print } inside && !/\\$/ { exit }' "$SKILL" |
		grep -oE -- '--[a-z-]+'
}

# Skip the test when the decisionkit CLI is not installed. Otherwise store
# its help text in HELP. Call it directly, not in a subshell, so that skip
# ends the test.
need_decisionkit() {
	command -v decisionkit >/dev/null 2>&1 || skip "decisionkit is not installed"
	HELP=$(decisionkit --help </dev/null 2>&1)
}

@test "the questions block sets Q_MATCH, MATCH_MIN, Q_SLOP and SLOP_MAX" {
	[ "$(grep -c '^```sh questions$' "$SKILL")" = 1 ]
	load_questions
	[ -n "$Q_MATCH" ]
	[ -n "$Q_SLOP" ]
	[[ "$MATCH_MIN" =~ ^0\.[0-9]+$ ]]
	[[ "$SLOP_MAX" =~ ^[0-2](\.[0-9]+)?$ ]]
	# Q_SLOP is rated on a 0 to 2 scale, so the limit lies inside it.
	less_than 0 "$SLOP_MAX"
	less_than "$SLOP_MAX" 2
}

@test "calibrate.sh and the knowledge-curator runner read the questions block" {
	# Both scripts find the block by its fence, so the fence name is fixed.
	grep -qF "sh questions" "$CALIBRATE"
	grep -qF 'COLD_READER=$CURATOR_DIR/../cold-reader/SKILL.md' "$RUNNER"
	grep -qF 'read_block "$COLD_READER" questions' "$RUNNER"
	# The variables that the two scripts need.
	for name in Q_MATCH MATCH_MIN Q_SLOP SLOP_MAX; do
		grep -q "^$name=" <<<"$(questions_block)"
		grep -q "$name" "$CALIBRATE"
	done
	grep -q 'Q_SLOP' "$RUNNER"
	grep -q 'SLOP_MAX' "$RUNNER"
	# The skill warns about the fence and names the runner layer.
	[[ "$TEXT" == *"Do not rename the fence"* ]]
	[[ "$TEXT" == *'`slop` layer of the knowledge-curator test runner'* ]]
	grep -q '^layer_slop()' "$RUNNER"
}

@test "the skill states MATCH_MIN as the block sets it" {
	load_questions
	[[ "$TEXT" == *"\`MATCH_MIN\` is $MATCH_MIN by design"* ]]
}

@test "Q_SLOP defines the levels that every score command names" {
	load_questions
	for level in none some heavy; do
		[[ "$Q_SLOP" == *"$level: "* ]]
	done
	for file in "$SKILL" "$CALIBRATE" "$RUNNER"; do
		grep -qF 'decisionkit score "$Q_SLOP" none some heavy' "$file"
	done
}

@test "the calibration scores bracket SLOP_MAX" {
	load_questions
	read -r good bad < <(sed -nE 's/.*highest good piece scored ([0-9.]+) and the lowest bad piece scored ([0-9.]+),.*/\1 \2/p' <<<"$TEXT")
	[ -n "$good" ]
	[ -n "$bad" ]
	less_than "$good" "$SLOP_MAX" || {
		echo "The skill says the highest good piece scored $good, which is not below SLOP_MAX $SLOP_MAX."
		return 1
	}
	less_than "$SLOP_MAX" "$bad" || {
		echo "The skill says the lowest bad piece scored $bad, which is not above SLOP_MAX $SLOP_MAX."
		return 1
	}
}

@test "the calibration names the decisionkit version that mise.toml pins" {
	said=$(sed -nE 's/.*ran with decisionkit ([0-9.]+) and.*/\1/p' <<<"$TEXT")
	pinned=$(yq '.tools["npm:@adxtya21/decisionkit"].version // .tools["npm:@adxtya21/decisionkit"]' "$MISE")
	[ -n "$said" ]
	[ "$said" = "$pinned" ]
}

@test "the score drift in the skill matches SLOP_DRIFT in the runner" {
	said=$(sed -nE 's/.*Scores drift between runs by up to ([0-9]+\.[0-9]+)\..*/\1/p' <<<"$TEXT")
	owned=$(sed -n 's/^SLOP_DRIFT=//p' "$RUNNER")
	[ -n "$said" ]
	[ "$said" = "$owned" ]
}

@test "the fixture folders hold enough pieces, and calibrate.sh sees each of them" {
	# The plan requires at least 4 good and 4 bad pieces.
	[ "$(ls "$FIXTURES"/slop/good/*.txt | wc -l)" -ge 4 ]
	[ "$(ls "$FIXTURES"/slop/bad/*.txt | wc -l)" -ge 4 ]
	# calibrate.sh reads only the files that match these patterns.
	[ "$(ls "$FIXTURES"/match/same-*.txt | wc -l)" -ge 1 ]
	[ "$(ls "$FIXTURES"/match/differ-*.txt | wc -l)" -ge 1 ]
	[ -z "$(find "$FIXTURES/slop" -type f ! -name '*.txt')" ]
	[ -z "$(ls "$FIXTURES/match" | grep -vE '^(same|differ)-.*\.txt$')" ]
	for path in 'slop/good' 'slop/bad' 'match/same-*' 'match/differ-*'; do
		[[ "$TEXT" == *"\`$path\`"* ]]
	done
}

@test "each match fixture is a Q_MATCH input with one A: line, one B: line and no unclear list" {
	for file in "$FIXTURES"/match/*.txt; do
		[ "$(grep -cx 'A:' "$file")" = 1 ] || {
			echo "$file needs exactly one line A:."
			return 1
		}
		[ "$(grep -cx 'B:' "$file")" = 1 ] || {
			echo "$file needs exactly one line B:."
			return 1
		}
		a=$(grep -nx 'A:' "$file" | cut -d: -f1)
		b=$(grep -nx 'B:' "$file" | cut -d: -f1)
		# A: comes first, the piece sits between the labels, the restatement follows B:.
		[ "$a" = 1 ]
		[ "$b" -gt $((a + 1)) ]
		[ -n "$(tail -n +"$((b + 1))" "$file" | tr -d '[:space:]')" ]
		# The skill says: do not send the list of unclear points.
		! grep -qiE '^(unclear|restatement):' "$file"
	done
}

@test "calibrate.sh is an executable bash script that reads the fixture folders" {
	[ -x "$CALIBRATE" ]
	bash -n "$CALIBRATE"
	# Each fixture folder that the script reads is named in the skill.
	for path in slop/good slop/bad match; do
		grep -q "$path" "$CALIBRATE"
	done
}

@test "the Makefile runs calibrate.sh through the shared targets, and the skill names the command" {
	grep -qx 'include ../knowledge-curator/scripts/skill.mk' "$DIR/Makefile"
	[ -f "$SKILL_MK" ]
	grep -q '^calibrate:' "$DIR/Makefile"
	grep -qF 'scripts/calibrate.sh' "$DIR/Makefile"
	[[ "$TEXT" == *'`make -C .agents/skills/cold-reader calibrate`'* ]]
}

@test "every relative link in the skill resolves" {
	links=$(grep -oE '\]\([^)]+\)' "$SKILL" | sed -E 's/^\]\((.*)\)$/\1/' | grep -vE '^(https?:|#)' | sed 's/#.*//')
	[ -n "$links" ]
	for link in $links; do
		[ -e "$DIR/$link" ] || {
			echo "SKILL.md links to $link, but it does not exist."
			return 1
		}
	done
	# The privacy section sends the reader to the decisionkit skill.
	grep -qF '](../decisionkit/SKILL.md)' "$SKILL"
	[ -f "$ROOT/.agents/skills/decisionkit/SKILL.md" ]
}

@test "the claude command uses only flags that claude knows" {
	command -v claude >/dev/null || skip "claude is not installed"
	help=$(claude --help)
	flags=$(claude_flags)
	[ -n "$flags" ]
	grep -qE -- '^[[:space:]]*-p, --print([[:space:]]|$)' <<<"$help"
	for flag in $flags; do
		grep -qE -- "^[[:space:]]*(-[a-zA-Z], )?$flag([[:space:]]|,|\$)" <<<"$help" || {
			echo "claude --help does not list $flag."
			return 1
		}
	done
}

@test "the knowledge runner starts its cold reader with the flags of the skill" {
	flags=$(claude_flags)
	[ -n "$flags" ]
	for flag in $flags; do
		grep -qF -- "$flag" "$RUNNER" || {
			echo "test-skill.sh does not use $flag."
			return 1
		}
	done
	# The flags with an empty value.
	for flag in '--tools ""' '--setting-sources ""'; do
		grep -qF -- "$flag" "$SKILL"
		grep -qF -- "$flag" "$RUNNER"
	done
	grep -qF 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1' "$SKILL"
	grep -qF 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1' "$RUNNER"
}

@test "the check commands use the variables of the questions block" {
	load_questions
	commands=$(section 'Run the checks')
	for name in $(grep -oE '\$\{?(Q_[A-Z]+|[A-Z]+_(MIN|MAX))\}?' <<<"$commands" | tr -d '${}' | sort -u); do
		[ -n "${!name}" ] || {
			echo "The check commands use $name, but the questions block does not set it."
			return 1
		}
	done
	[[ "$commands" == *'decisionkit binary "$Q_MATCH" --threshold "$MATCH_MIN" --quiet'* ]]
}

@test "the check commands use options that decisionkit has" {
	need_decisionkit
	for word in binary score --threshold --quiet; do
		grep -qF -- "$word" <<<"$HELP"
	done
}

@test "the scope list, the reader table and the description name the same pieces" {
	description=$(yq --front-matter=extract '.description' "$SKILL" | tr '\n' ' ')
	scope=$(section Scope)
	reader=$(section 'Start the reader')
	# One scope bullet and one table row for each kind of piece. The table
	# has a header row and a separator row.
	bullets=$(grep -c '^- ' <<<"$scope")
	rows=$(($(grep -c '^| ' <<<"$reader") - 2))
	[ "$bullets" -ge 3 ]
	[ "$rows" = "$bullets" ]
	# Every list names each kind, and the first column of the table too.
	for piece in 'skill' 'AGENTS.md' 'README' 'docs' 'config'; do
		for where in "$description" "$scope" "$(grep '^| ' <<<"$reader" | tail -n +3 | cut -d'|' -f2)"; do
			grep -qiF -- "$piece" <<<"$where" || {
				echo "Not every list names the piece: $piece."
				return 1
			}
		done
	done
}

@test "the front matter names the skill folder" {
	[ "$(yq --front-matter=extract '.name' "$SKILL")" = cold-reader ]
}

@test "the procedure repeat step names the steps before it, and the scoring step sits before it" {
	proc=$(section Procedure | tr '\n' ' ' | tr -s ' ')
	steps=$(section Procedure | grep -cE '^[0-9]+\. \*\*')
	last=$(section Procedure | grep -E '^[0-9]+\. \*\*' | tail -n 1)
	[[ "$last" == "$steps. **Fix and repeat.**"* ]]
	[[ "$proc" =~ run\ steps\ 1\ to\ ([0-9]+)\ again ]]
	[ "${BASH_REMATCH[1]}" = $((steps - 1)) ]
	[[ "$proc" == *"$((steps - 1)). **Score each piece with decisionkit.**"* ]]
	[[ "$proc" == *"A piece passes when \`Q_MATCH\` is true and the \`Q_SLOP\` expected value is below \`SLOP_MAX\`."* ]]
}

@test "the prompt block has the parts that the procedure reads" {
	prompt=$(awk '/^```text$/ { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL")
	[ -n "$prompt" ]
	grep -q '^Restatement:' <<<"$prompt"
	grep -q '^Unclear:' <<<"$prompt"
	# The skill describes the blocks that follow the prompt.
	[[ "$TEXT" == *"\`N. Path: <value>\`"* ]]
	[[ "$TEXT" == *"\`Piece:\`"* ]]
}

@test "the Vale step names a command and a task that mise.toml supports" {
	[[ "$TEXT" == *'`mise exec -- vale <file>`'* ]]
	grep -qE '^vale = "[0-9]' "$MISE"
	# The step sends a missing-package error to vale sync. The setup task runs it.
	[[ "$TEXT" == *'`mise exec -- vale sync`'* ]]
	yq '.tasks.setup.run[]' "$MISE" | grep -qx 'vale sync'
	# The skill points to the task that lints every tracked Markdown file.
	[[ "$TEXT" == *'`mise run prose:lint`'* ]]
	[ "$(yq '.tasks."prose:lint".description != null' "$MISE")" = true ]
	yq '.tasks."prose:lint".run' "$MISE" | grep -q 'vale'
}

@test ".vale.ini sets the ai-tells package and the House styles that the skill names" {
	[ -f "$VALE_INI" ]
	# Vale reads the config from the repository root, so step 1 starts there.
	[[ "$TEXT" == *'From the repository root, run `mise exec -- vale <file>`'* ]]
	[[ "$TEXT" == *'the `ai-tells` package and the `House` styles'* ]]
	grep -qE '^Packages = .*ai-tells' "$VALE_INI"
	grep -qE '^BasedOnStyles = .*ai-tells.*House' "$VALE_INI"
	# The House styles are our own and are committed, unlike the package.
	[ -d "$ROOT/.vale/styles/House" ]
	[ -n "$(find "$ROOT/.vale/styles/House" -name '*.yml' -type f)" ]
	grep -qE '^StylesPath = \.vale/styles$' "$VALE_INI"
}

@test "the vale pre-commit hook lints Markdown through mise, as the skill says" {
	hook='.repos[].hooks[] | select(.id == "vale")'
	[ "$(yq "$hook | .entry" "$HOOKS")" = "mise exec -- vale" ]
	[ "$(yq "$hook | .types[0]" "$HOOKS")" = markdown ]
	[[ "$TEXT" == *'The `vale` pre-commit hook lints each staged `.md` file'* ]]
}

@test "Vale covers the file type of each piece, or step 1 says how to lint it" {
	# Vale lints a file only when .vale.ini has a section for its extension.
	# Without one, "vale <file>" prints "0 files" and exits 0. Then step 1
	# must name .vale.ini and send the piece through a .md file. Config
	# comments live in these file types.
	grep -qE '^\[\*\.md\]' "$VALE_INI"
	globs=$(grep '^\[' "$VALE_INI" | tr -c 'a-z0-9\n' '\n')
	step1=$(section Procedure | awk '/^1\. / { inside = 1; print; next } inside && /^[0-9]+\. / { exit } inside' | tr '\n' ' ' | tr -s ' ')
	[ -n "$step1" ]
	for ext in toml yaml yml ini; do
		grep -qx "$ext" <<<"$globs" && continue
		[[ "$step1" == *'`.vale.ini`'* && "$step1" == *'`.md` file in a temporary directory'* ]] || {
			echo ".vale.ini has no section for .$ext, and step 1 does not say that it covers only some files."
			return 1
		}
	done
}
