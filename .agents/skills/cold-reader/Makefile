# Skill tests. Run from the repository root:
#   make -C .agents/skills/cold-reader test
# The knowledge-curator skill explains the layers in "Test a skill".
include ../knowledge-curator/scripts/skill.mk

.PHONY: calibrate

test: calibrate

# Score the synthetic fixtures in references/fixtures. It sends them to
# decisionkit, about 36 calls. Run it after a change to a question, a
# threshold or a fixture.
calibrate:
	@mise exec -- scripts/calibrate.sh
