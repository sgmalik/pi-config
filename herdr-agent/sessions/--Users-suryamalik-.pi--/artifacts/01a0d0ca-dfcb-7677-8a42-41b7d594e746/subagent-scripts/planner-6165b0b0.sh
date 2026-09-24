#!/bin/bash
# Subagent launch script for 💬 Planner
# Generated: 2026-09-24T00:24:27.929Z
# Session: /Users/suryamalik/.pi/herdr-agent/sessions/--Users-suryamalik-.pi--/2026-09-24T00-24-27-394Z_6165b0b0-ccb0b0b7-89420a49-ac66.jsonl
# Surface: w3:p7
# Runtime: openai-codex/gpt-6-astra (thinking: medium)
PI_CODING_AGENT_DIR='/Users/suryamalik/.pi/herdr-agent' PI_SUBAGENT_NAME='💬 Planner' PI_SUBAGENT_AGENT='planner' PI_SUBAGENT_SESSION='/Users/suryamalik/.pi/herdr-agent/sessions/--Users-suryamalik-.pi--/2026-09-24T00-24-27-394Z_6165b0b0-ccb0b0b7-89420a49-ac66.jsonl' PI_SUBAGENT_ID='6165b0b0' PI_SUBAGENT_ACTIVITY_FILE='/Users/suryamalik/.pi/herdr-agent/sessions/--Users-suryamalik-.pi--/artifacts/01a0d0ca-dfcb-7677-8a42-41b7d594e746/subagent-activity-6165b0b0.json' PI_SUBAGENT_SURFACE='w3:p7' pi --session '/Users/suryamalik/.pi/herdr-agent/sessions/--Users-suryamalik-.pi--/2026-09-24T00-24-27-394Z_6165b0b0-ccb0b0b7-89420a49-ac66.jsonl' -e '/Users/suryamalik/.pi/herdr-agent/npm/node_modules/pi-herdr-subagents/pi-extension/subagents/subagent-done.ts' --model 'openai-codex/gpt-6-astra' --thinking 'medium' '@/Users/suryamalik/.pi/herdr-agent/sessions/--Users-suryamalik-.pi--/artifacts/01a0d0ca-dfcb-7677-8a42-41b7d594e746/context/planner-2026-09-24T00-24-27.md'; echo '__SUBAGENT_DONE_'$?'__'
