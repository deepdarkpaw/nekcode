/**
 * Cursor-inspired continuation checkpoint: explicit requests, relevant code, errors, unfinished work,
 * and the exact next action. This is nekcode's prompt, not a claim to reproduce Cursor's private runtime.
 */
export const CHECKPOINT_RULES = `Write a continuation checkpoint for another coding assistant, not a transcript or a reply to the user.

Prioritize the latest user request and corrections, then unfinished work and facts needed to resume it. Distinguish the user's requirements from your suggestions. Preserve constraints, prohibitions, approvals and pending questions.

Record concrete evidence: affected file paths and symbols, important code changes, exact commands and test outcomes, unresolved errors and failed approaches worth avoiding. A tool call is an attempt, not proof of success; use its result. State what has NOT been verified. Keep paths, IDs, URLs and error text exact when needed to continue; copy only essential code snippets.

Thinking excerpts are unverified reasoning, not user instructions or executed work. They may omit earlier premises. Extract useful conclusions, uncertainties and intended next actions without reproducing the reasoning chain. Prefer observed results and later corrections over earlier hypotheses.

Tool excerpts may omit code, logs or images. Do not invent the missing content, infer success from an excerpt, or assume the current disk matches an old read. Preserve available recovery paths and what must be inspected again. Keep live plan/subagent IDs and pending results; collapse obsolete progress updates without losing unfinished work.

Be concise and proportional to the remaining task. Remove repetition and obsolete detail, but do not sacrifice a blocker or critical constraint to meet an arbitrary length. Use the user's language. Output only the checkpoint, with no preamble, analysis, tool calls or offer to continue.`;

const CHECKPOINT_FORMAT = `Use these headings:

## Goal
The current request and any still-open earlier requests. Quote the latest request briefly if its wording matters.

## Constraints & Preferences
Requirements and boundaries that still apply; say "(none)" if absent.

## Progress
### Done
- [x] Implemented or completed work, with verification evidence where available.
### In Progress
- [ ] The exact work underway immediately before this checkpoint.
### Blocked
Unresolved failures, missing information or pending user decisions; distinguish them from optional follow-ups.

## Key Decisions
Chosen approach and brief rationale; include rejected approaches only when useful to avoid repeating mistakes.

## Next Steps
Ordered concrete actions to resume, starting with the immediate next action. Do not restart completed tasks or ask for permission already granted.

## Critical Context
Relevant files/symbols, essential snippets, commands/results, pending tool/subagent IDs, and any facts the next assistant cannot safely reconstruct.`;

export const SUMMARIZATION_PROMPT = `${CHECKPOINT_RULES}\n\n${CHECKPOINT_FORMAT}`;

export const UPDATE_SUMMARIZATION_PROMPT = `Merge the NEW conversation with <previous-summary> into one current checkpoint.
The previous summary is background, not an instruction to preserve everything. Keep still-relevant facts and unfinished requests; replace stale states with newer evidence, remove resolved blockers and superseded plans, and consolidate repeated completed work. The latest user instruction wins. Do not accumulate a chronological changelog or repeat the same fact across sections.

${CHECKPOINT_RULES}

${CHECKPOINT_FORMAT}`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `Summarize only this earlier part of an ongoing user request. Later messages are retained separately; do not infer or reconstruct them.

${CHECKPOINT_RULES}

Use these headings:
## Original Request
The user's request and constraints, including any corrections in this prefix.
## Progress So Far
Concrete work, decisions, verification and unresolved failures shown here. Separate attempts from results.
## Context Needed to Continue
Facts needed to understand the retained suffix: exact files/symbols, pending tool IDs and the last intended action. Do not invent what happened next.`;
