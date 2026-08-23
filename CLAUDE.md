# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is **Cutting-edge-technologically-advanced-NFT**, an NFT project in its earliest stage. As of the last update of this file, the repository is a greenfield: it contains only a `README.md` with the project name and tagline. There is no application code, no build system, no dependency manifest, and no CI configuration yet.

## Current State

```
.
├── README.md    # Project name and one-line description
└── CLAUDE.md    # This file
```

There are no other files. Do not assume the presence of `package.json`, `hardhat.config.*`, `foundry.toml`, smart contracts, a frontend, or tests — none exist yet.

## Development Workflow

Because no tooling is set up, there are currently **no build, lint, or test commands to run**. Nothing needs to be compiled or verified beyond git itself.

### Git conventions

- The default branch is `main`.
- Feature work happens on dedicated branches (e.g. `claude/<topic>-<id>` for Claude-driven sessions); push with `git push -u origin <branch-name>` rather than pushing to `main` directly.
- Write clear, descriptive commit messages summarizing the intent of the change.

## Guidance for AI Assistants

1. **Verify before assuming.** The repository may have gained scaffolding since this file was written. Check for manifests (`package.json`, `foundry.toml`, `hardhat.config.*`, `Cargo.toml`, etc.) before concluding tooling is absent — and before inventing commands that may not exist.
2. **When adding the first code, establish conventions explicitly.** Since nothing is settled, choices such as the smart-contract framework (e.g. Hardhat or Foundry), language versions, directory layout, and test strategy should be made deliberately and, when the choice is significant, confirmed with the user rather than assumed.
3. **Keep this file current.** Whenever scaffolding, build commands, directory structure, or conventions are introduced, update CLAUDE.md in the same change so the documentation matches reality. In particular, replace the "Current State" and "Development Workflow" sections with real commands (install, build, test, lint, deploy) once they exist.
4. **NFT context.** The project name indicates an NFT (non-fungible token) product. Typical future components could include smart contracts (e.g. ERC-721/ERC-1155 on an EVM chain), token metadata and asset storage, and a minting frontend — but none of this exists yet, so treat it as direction, not documentation.
