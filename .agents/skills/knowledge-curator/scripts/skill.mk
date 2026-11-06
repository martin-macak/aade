# Shared targets for skill tests. Each skill Makefile includes this file.
# The knowledge-curator skill explains the layers in "Test a skill".
# drift needs no LLM. triggers and knowledge call Claude headless, and
# knowledge and slop call decisionkit, so no hook or CI job runs them.
# Add -k to run every layer after a failure.
RUN := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))/test-skill.sh

.PHONY: test drift triggers knowledge slop

test: drift triggers knowledge slop

drift triggers knowledge slop:
	@mise exec -- "$(RUN)" $@ "$(CURDIR)"
