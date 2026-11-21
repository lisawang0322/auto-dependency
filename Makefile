# Throughline: helper targets. See README.md.

.PHONY: devin-skills test py-setup start

# Copy each skill (SKILL.md + reference/ + templates/) into .agents/skills/, where Devin loads skills.
# skills/ is the source; never edit .agents/ by hand.
devin-skills:
	@rm -rf .agents/skills
	@for d in skills/*/; do \
	  name=$$(basename $$d); \
	  mkdir -p .agents/skills/$$name; \
	  cp $$d/SKILL.md .agents/skills/$$name/SKILL.md; \
	  for sub in reference templates; do [ -d $$d/$$sub ] && cp -R $$d/$$sub .agents/skills/$$name/ || true; done; \
	  echo "  .agents/skills/$$name/SKILL.md"; \
	done
	@echo "Copied from skills/ by 'make devin-skills'. Do not edit .agents/ by hand." > .agents/skills/README.md

# Python for deck reading, the fixture builder, seed_jira.py and eval/score.py.
py-setup:
	python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

test:
	npm test

# Build the GUI and serve it with the API on http://localhost:8787.
start:
	npm start
