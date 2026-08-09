# PawsMemories — Agent Guide

## GitReverse: reverse-engineer any public repo into a prompt

`tools/gitreverse/` is a Next.js app that converts a public GitHub repo into a
single descriptive prompt, useful when you need to understand a library or
reference implementation before using it.

### When to use it

- You are about to integrate an unfamiliar package or GitHub project.
- You want a concise summary of how an external repo is structured before
  reading its source.

### How to run it (one-time setup per session)

```bash
cd tools/gitreverse
pnpm install
pnpm dev          # starts on http://localhost:3000
```

### How to query it

```bash
# GET /owner/repo — returns a page whose main text block is the generated prompt
curl http://localhost:3000/<owner>/<repo>
# or open in browser: http://localhost:3000/<owner>/<repo>
```

Paste the output prompt back into your context whenever you need background on
that repo.

### Tear-down

Kill the dev server (`Ctrl-C`) when you are done. The submodule does not affect
the main PawsMemories build.
