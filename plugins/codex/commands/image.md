---
description: Generate an image with Codex's built-in $imagegen skill (gpt-image-2, billed to your ChatGPT subscription)
argument-hint: '"<prompt>" [--name <name>] [--outdir <dir>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/image-gen.mjs" "$ARGUMENTS"`
