# Evals

Manual evaluations for the `setup-ai-sdk-harness` skill: introspection first, the choice of the sandbox, the network, sessions, and the guards (Node.js 24 and ESM, credential brokering).

## Format

`skill.json` is a JSON array:

```json
[
  {
    "query": "User input to test",
    "expected_behavior": "What the response should do."
  }
]
```

## Running them

In Claude Code:

```
Run the evals in skills/setup-ai-sdk-harness/evals/skill.json. For each query, spawn an agent with the whole SKILL.md and its references/*.md as context, and compare its response against expected_behavior. Report pass or fail for each.
```
