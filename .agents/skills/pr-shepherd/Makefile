# Skill tests. Run from the repository root:
#   make -C .agents/skills/pr-shepherd test
# The knowledge-curator skill explains the layers in "Test a skill".
# The drift layer runs tests/shepherd.bats and tests/verify.bats, the tests
# of scripts/shepherd.sh.
include ../knowledge-curator/scripts/skill.mk

.PHONY: calibrate

test: calibrate

# Score the synthetic fixtures in tests/fixtures/calibration with the
# questions in references/questions.yml. It sends them to decisionkit,
# about 65 calls. Run it after a change to a question, a threshold or a
# fixture.
calibrate:
	@mise exec -- ../decisionkit/scripts/decide.sh calibrate references/questions.yml tests/fixtures/calibration
