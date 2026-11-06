# Skill tests. Run from the repository root:
#   make -C .agents/skills/knowledge-curator test
# The section "Test a skill" in SKILL.md explains the layers.
include ../knowledge-curator/scripts/skill.mk

.PHONY: calibrate

test: calibrate

# Score the Q_KNOW fixtures. Run it after a change to Q_KNOW.
calibrate:
	@mise exec -- "$(RUN)" calibrate "$(CURDIR)"
