# Dependency security policy

## Production tree

`npm run audit:prod` is a required CI check and currently reports zero vulnerabilities. It runs
`npm audit --omit=dev --audit-level=high`, so any future high or critical advisory reachable from
the installable production dependency tree blocks the build.

The two LayerZero packages previously listed as direct dependencies were not imported anywhere in
the contracts, scripts, SDK, CLI, or UI. ANIMA implements neither `OApp` nor `ONFT`; its bridge calls
the deployed LayerZero V2 endpoint through the minimal ABI in `contracts/omni/ILayerZeroV2.sol`.
Removing those unused packages deleted 130 transitive packages, including legacy Chainlink CCIP,
OpenZeppelin 3/4, ethers 5, elliptic, axios, `ws`, and `hardhat-deploy`. This is dependency removal,
not an override: no vulnerable version is forced beneath a consumer that expected another version.

The runtime Solidity dependencies are now limited to OpenZeppelin Contracts, OpenZeppelin Contracts
Upgradeable, and Solady. `npm ls --omit=dev --all` should be reviewed whenever this set changes.

## Development tree

The unfiltered `npm audit` currently reports 12 low and one high advisory in development-only tools:

- Hardhat's verification/ignition plugins retain an ethers 5 signing dependency whose `elliptic`
  advisory has no upstream fix in the current plugin line.
- The pinned `solc` 0.8.28 JavaScript package uses `tmp`; npm proposes downgrading to solc 0.5.0 as
  its automated “fix”, which is incompatible with the contracts and must not be applied.

These packages are build tools, not browser/server runtime dependencies, and the application does
not accept attacker-controlled compiler paths or invoke the affected ethers 5 signing API. This is
a bounded exposure, not a claim that development dependencies are harmless. CI uses an ephemeral
runner, `solc` is pinned exactly to 0.8.28, lockfile integrity is enforced by `npm ci`, and production
artifacts must be built from a reviewed commit. Reassess these exceptions when Hardhat, its toolbox,
or the compiler package publishes a compatible fix.

## Update procedure

1. Run `npm audit --omit=dev`, `npm audit`, and `npm ls --omit=dev --all`.
2. Prefer removing unused dependencies or upgrading direct dependencies over npm `overrides`.
3. Never run `npm audit fix --force` without reviewing the proposed dependency graph and running both
   monolith and diamond suites; npm currently proposes an incompatible compiler downgrade.
4. Run `npm run test:both`, `npx tsc --noEmit`, and `npm run ui:build` after every dependency change.
5. Record any accepted development-only advisory here with its path, reachability, and compensating
   controls. Production high/critical findings are not accepted by policy.
