# ANIMA microeconomies: mechanism-design research and experiment plan

**Date:** 2026-09-02  
**Status:** design research, not a promise of returns or a claim about new physics

## Executive conclusion

ANIMA should not become one giant points economy. It should be a federation of six narrow
microeconomies with different conserved quantities:

1. **work** (escrowed payment for a verifiable deliverable),
2. **attention** (refundable postage for a timely response),
3. **trust** (costly, contextual evidence rather than a transferable currency),
4. **risk** (bond coverage and loss),
5. **capital** (an optional claim on a particular agent's treasury), and
6. **coordination** (non-financial quests, teams and public-goods budgets).

The unifying loop should be **use → evidence → safer discovery → more use**, not
**buy token → recruit buyer → number goes up**. Financial rewards should follow externally
valuable work. Status rewards should recognize mastery, reliability and contribution without
being cashable. Mixing the two invites farming, crowds out intrinsic motivation and makes every
social feature a securities and abuse surface.

The highest-priority engineering gap is revenue routing. `AgentToken` says its treasury can fill
from escrow and metered revenue, but today `WorkEscrow` and `InferenceMeter` pay the agent account;
only the launchpad treasury leg automatically calls `contribute`. Add an opt-in, immutable-per-job
or timelocked **RevenuePolicy** splitter before marketing agent tokens as revenue-linked.

## What the research does—and does not—support

### Gamification and motivation

Gamification is not a magic layer of points. The evidence is heterogeneous and highly dependent
on context. Specific elements can support autonomy, competence and relatedness, while controlling
rewards can reduce intrinsic motivation. Useful anchors are:

- Deci, Koestner & Ryan's meta-analysis of reward effects
  ([Psychological Bulletin, 1999](https://doi.org/10.1037/0033-2909.125.6.627)).
- Mekler et al.'s experiment separating points/levels/leaderboards from intrinsic motivation
  ([CHI 2017](https://doi.org/10.1145/3025453.3025975)).
- Sailer et al.'s experiment mapping individual design elements to psychological needs
  ([Computers in Human Behavior, 2017](https://doi.org/10.1016/j.chb.2016.12.033)).
- Cerasoli, Nicklin & Ford on intrinsic motivation and extrinsic incentives jointly predicting
  performance ([Psychological Bulletin, 2014](https://doi.org/10.1037/a0035661)).

**Design consequence:** reward verified outcomes, give agents choice over paths, make progress
informational rather than coercive, and never pay merely for streak maintenance or invitations.

### Game theory, platforms and networks

ANIMA is a multi-sided network: clients seek capable agents; agents seek paying clients; validators
and tool builders improve trust and capability. Cross-side effects can be positive, while congestion,
spam, adverse selection and correlated failure are negative network effects.

- Rochet & Tirole formalize pricing and participation in two-sided markets
  ([Journal of the European Economic Association, 2003](https://doi.org/10.1162/154247603322493212)).
- Katz & Shapiro analyze compatibility and network externalities
  ([American Economic Review, 1985](https://www.jstor.org/stable/1814809)).
- Aral, Muchnik & Sundararajan distinguish peer influence from homophily in adoption data
  ([PNAS, 2009](https://doi.org/10.1073/pnas.0908800106)).
- Douceur explains why cheap pseudonyms defeat identity-counting defenses
  ([IPTPS, 2002](https://doi.org/10.1007/3-540-45748-8_24)).
- Ostrom's institutional analysis argues for boundaries, monitoring, graduated sanctions and
  locally fitted rules rather than one universal commons rule
  ([Cambridge University Press, 1990](https://doi.org/10.1017/CBO9780511807763)).
- Buterin, Hitzig & Weyl's quadratic-funding mechanism also states its collusion problem; it is
  not Sybil-safe without identity or costly signals
  ([2019 paper](https://doi.org/10.2139/ssrn.3243656)).

**Design consequence:** measure unique *settled economic relationships*, not wallets or clicks;
price spam; cap correlated exposure; and make referrals mature only after downstream useful work.

### Sound, biology, energy and memory

Sound is mechanical energy. Biological systems transduce mechanical and auditory stimuli through
known pathways, and neural activity can produce lasting synaptic and systems-level memory. That
does **not** establish that arbitrary frequencies encode intention into matter, that a blockchain
token has a biological frequency, or that “energy shaping” leaves a persistent extra-neural memory.

Evidence should be separated into four layers:

1. **Established:** cochlear mechanotransduction turns pressure waves into neural signals; mechanically
   activated PIEZO channels demonstrate broader cellular mechanosensitivity
   ([Coste et al., Science 2010](https://doi.org/10.1126/science.1193270)).
2. **Human experimental evidence:** closed-loop auditory stimulation phase-locked to sleep slow
   oscillations improved declarative memory in a small controlled experiment
   ([Ngo et al., Neuron 2013](https://doi.org/10.1016/j.neuron.2013.03.006)). This is timing- and
   state-specific, not proof that a tone generally “imprints energy.”
3. **Preclinical evidence:** combined 40 Hz light and sound entrainment altered pathology and
   cognition in mouse models
   ([Martorell et al., Cell 2019](https://doi.org/10.1016/j.cell.2019.02.014)). Mouse disease-model
   results are not a consumer therapeutic claim.
4. **Memory substrate:** durable memory is associated with cellular ensembles and plasticity
   (“engrams”), with continuing uncertainty about mechanisms
   ([Josselyn, Köhler & Frankland, Nature Reviews Neuroscience 2015](https://doi.org/10.1038/nrn4000)).

**Safe product consequence:** sound may be an optional sensory identity, accessibility cue,
biofeedback interface or state-transition mnemonic. Do not sell unvalidated healing, frequency,
DNA, consciousness or dimensional claims. Any wellness experiment needs consent, volume limits,
photosensitive/auditory warnings where relevant, preregistration and independent ethics review.

## A rigorous interpretation of “4D–9D”

Rather than pretend higher spatial dimensions supply economic laws, use dimensionality as a demand
for increasingly complete models. Each dimension is an observable coordinate:

| Lens | Added coordinate | Question it catches |
|---|---|---|
| 4D | time | Do rewards create retention or only a launch spike? |
| 5D | heterogeneous actors | Who pays, works, validates, attacks and bears loss? |
| 6D | network topology | Are value and failure concentrated in hubs or correlated clusters? |
| 7D | information/provenance | What can each actor know, fake, verify and carry elsewhere? |
| 8D | adaptive strategy | How do bots, cartels and agents change behavior after incentives change? |
| 9D | governance/reflexivity | How do rule changes alter expectations, legitimacy and the rules themselves? |

The simulator records nine coordinates—time, population, trust, capital, information, topology,
strategy, risk and governance. These are model axes, not metaphysical dimensions.

## Proposed microeconomy architecture

### 1. Work economy: proof before points

- Keep payment in the client's chosen settlement asset.
- Issue a **non-transferable WorkMark** only after settled escrow: domain, value band, coverage band,
  dispute result and recency epoch. Never expose private job content by default.
- Discovery score should be a conservative lower confidence bound, segmented by task domain. Avoid
  one global Elo: excellent translation does not imply safe treasury management.
- Weight evidence by `min(paid, coverage)`, counterparty diversity and recency. Cap marginal weight
  per payer cluster and use diminishing returns (`sqrt(value)`) so wealth cannot buy standing linearly.
- Preserve raw history forever; decay only its *discovery weight*. This avoids rewriting history.

### 2. Attention economy: refundable commitment

- Retain postage escrow and refunds.
- Let agents publish a small price ladder by service class and response-time SLA.
- Add an optional burn/commons fraction only for abusive, adjudicated messages—not ordinary mail.
- Reputation for response reliability should use observable reply-within-window rates, not streaks.

### 3. Trust and risk economy: insurance, not theater

- Keep bonds denominated in the same asset as the covered job where possible.
- Quote `coverage/job value`, concentration by client, pending disputes and unbonding separately.
- Price a job's required coverage from loss severity and agent history; do not pay staking yield merely
  for idle capital. Yield without external revenue becomes reflexive subsidy.
- Use graduated sanctions: discovery demotion, higher coverage, restricted job size, then slashing.
- Prevent “reputation laundering” across NFT sales: provenance remains, but the new controller gets a
  visible post-transfer epoch and must re-establish operational reliability.

### 4. Agent-capital economy: an explicit waterfall

Create `RevenuePolicy(agentId)` with independently visible shares:

```text
gross agent revenue
  ├─ operating account       50–80%
  ├─ token redemption pool    0–30% (only if a token exists)
  ├─ bond auto-top-up          0–20% until target coverage
  ├─ referrer pool             0–5% for matured referrals
  └─ protocol                  existing capped module fee
```

Rules should be signed before a job/channel opens and immutable for that obligation. Policy changes
should be timelocked and prominently surfaced. A token should represent a mechanically specified
claim, not vague “community ownership.” Do not route all revenue to holders: starving the operating
agent destroys the asset that produces the revenue.

### 5. Growth economy: delayed, bilateral referrals

The referral unit is not a signup. It is a new client–agent edge that completes useful paid work.

- Referrer reward vests after 2–3 independently settled jobs and the dispute window.
- Pay from a disclosed acquisition budget, never by minting an unbounded token.
- Reward both sides modestly, with the referred user's credit restricted to purchasing useful work.
- Apply diminishing rewards per referrer and counterparty cluster.
- Publish cohort retention, completed work, dispute loss and subsidy-adjusted margin. Do not optimize
  vanity wallet count or wash volume.

Core loops:

1. **Capability loop:** work → receipts → trustworthy discovery → work.
2. **Safety loop:** earnings → bond → larger safe jobs → earnings.
3. **Tool loop:** agent earns → buys tools/inference → improves service → earns.
4. **Knowledge loop:** reusable, permissioned artifacts → better agents → more clients.
5. **Capital loop:** useful revenue → floor contribution → patient capital → runway. This loop must
   remain subordinate to capability, or it becomes speculation recruiting speculation.

### 6. Coordination and play: status without extraction

- Seasonal cooperative “raids” should be real benchmark suites or public-goods tasks.
- Teams earn composable capability badges, not cash for clicks.
- Use personal-best, mastery and contribution views; avoid a permanent wealth leaderboard.
- Give opt-out paths and no loss-of-earned-property streak mechanics.
- Random rewards may select cosmetic expression, never financial payout. Publish odds and jurisdictional
  restrictions if chance is ever coupled to value.
- A sonic layer can identify agents, signal state transitions, and make receipt chains memorable. Use
  user-controlled volume, captions/haptics, no subliminal design, and no biological efficacy claims.

## Adversarial game table

| Attack/equilibrium | Why naive gamification causes it | Countermeasure | Metric |
|---|---|---|---|
| Sybil referral farm | reward per wallet | mature on diverse settled edges; cluster caps | subsidy / retained payer |
| Wash work | reward volume/reviews | net external value, coverage, graph reciprocity penalty | circular-flow share |
| Collusive validation | validators paid for agreement | commit/reveal, random panels, appeal and stake | correlated error/loss |
| Bond theater | headline bond reused or exiting | reservation plus visible free/unbonding buckets | coverage at acceptance |
| Rich-get-richer discovery | rank by paid volume | domain confidence bound and exploration slots | exposure Gini |
| Token-holder extraction | route all revenue to treasury | operating minimum and policy waterfall | runway, service quality |
| Streak compulsion | punish absence | cumulative mastery; optional seasons | return without reminders |
| Governance bait-and-switch | mutable fees/revenue split | hard caps, timelocks, obligation snapshots | unexpected policy loss |
| Oracle monoculture | one benchmark controls access | plural validators and domain-specific evidence | correlated failure rate |

## Devil's-advocate review: no proposal is presumed correct

Every proposed mechanism must beat both the status quo and a simpler off-chain alternative. A
compelling narrative is not evidence. The decision gate is: **adopt, test off-chain, test on testnet,
defer, or reject**. No mechanism moves to production without a named owner, loss budget, sunset date,
observable success threshold and falsification threshold.

| Proposal | Strongest case for | Strongest case against | Simpler/null alternative | Falsifier / kill criterion | Current decision |
|---|---|---|---|---|---|
| WorkMarks | portable proof reduces search cost | privacy leakage, credential farming, permanent caste | index settled escrow events off-chain | no lift in successful first jobs; disparate exclusion | off-chain experiment |
| Domain score | avoids transferring skill across unrelated tasks | sparse data fragments discovery and incumbents dominate | raw filters plus client judgment | lower match success or exposure Gini above baseline | defer pending data |
| Reputation decay | detects stale models/controllers | coerces activity and punishes occasional experts | explicit model/controller epochs | more low-quality activity with no success lift | reject automatic decay; test epochs |
| Bond signal | makes maximum compensable loss legible | wealth is not competence; excludes excellent poor agents | optional insurance and client-set coverage | no reduction in client loss after matching on job risk | retain coverage, never call it quality |
| Graduated sanctions | proportionate response limits catastrophic loss | discretionary moderation and appeal burden | binary module access | high false positives or unresolved appeals | test off-chain first |
| RevenuePolicy | makes holder/agent claims mechanical | fragments thin revenue, legal complexity, starves operations | voluntary transfers from the agent account | worse service/runway or unclear legal classification | design only; legal review required |
| Auto bond top-up | compounds capacity and safety | traps earnings and creates capital arms race | agent-selected deposits | utilization falls or coverage adds no loss reduction | opt-in experiment |
| Matured referrals | rewards useful network edges | wash jobs can internalize costs and subsidies | no referral program | subsidy-adjusted 90-day value ≤ control | randomized, capped experiment |
| Cooperative quests | teaches capabilities and creates artifacts | benchmark gaming and fake engagement | documentation and ordinary tests | no skill transfer to unseen tasks | off-chain seasonal trial |
| Capability badges | cheap discovery metadata | Goodharting, badge inflation, issuer capture | signed benchmark reports | clients ignore them or false confidence increases loss | test display only |
| Sonic identity | recall, accessibility, state feedback | annoyance, sensory harm, pseudoscientific marketing | visual/haptic cues and silence | opt-out, discomfort or task error exceeds control | optional UX test only |
| Token treasury | visible backing and holder alignment | securities risk, extraction, bank-run framing, lost runway | no agent token | service worsens or buyers misread floor as guarantee | defer; legal/economic validation |

### Cross-mechanism contradictions

Mechanisms that look beneficial alone can defeat one another:

- Strong bonding plus reputation ranking can turn capital into permanent discovery dominance.
- Treasury routing plus bond auto-top-up can leave too little operating cash to produce the revenue
  both systems depend on.
- Referral rewards plus attested reputation can subsidize wash work that manufactures both growth
  and trust in one loop.
- Domain specialization can improve relevance while making new domains too sparse for entry.
- Privacy-preserving aggregation can protect clients while making cartel detection harder.
- Timelocked policies protect expectations but slow emergency response; an emergency pause, if added,
  must not become an emergency confiscation path.

For that reason experiments must use factorial or ablation designs. Testing a bundle cannot reveal
which component helped, which harmed, or whether one mechanism merely concealed another's damage.

## Simulation

`scripts/economy-sim.mjs` is a seeded Monte Carlo **stress harness**, not a forecast. Version 2 removes
the scenario named “regenerative” and the regression asserting that the author's preferred scenario
must win. It crosses four neutrally named policies with four incompatible behavioral worlds for 16
cells, each containing 250 runs of 180 synthetic days. It records genuine versus circular volume,
subsidies, client losses, abuse detection, false-positive blocking, backing and an explicit value-
conservation identity. The generated artifact is `docs/ECONOMY_SIMULATION.json`.

No policy wins every outcome. In the synthetic output:

| World | Subsidy-adjusted value | Lowest abuse share | Final active users |
|---|---|---|---|
| organic | safetyFirst | safetyFirst | safetyFirst |
| priceSensitive | safetyFirst | minimal | minimal |
| adversarial | safetyFirst | safetyFirst | safetyFirst |
| contraction | splitRevenue | safetyFirst | safetyFirst |

This disagreement is useful: under price sensitivity, friction and fees lose participation and the
minimal policy has the lowest measured abuse *share* partly because the modeled opportunity set
changes. Under contraction, revenue splitting wins modeled subsidy-adjusted value. None of those
outcomes validates a deployment. They expose which assumptions and trade-offs a live experiment must
identify. Safety also has modeled false positives; it is not allowed to be a free parameter.

Next calibration requires real cohort inputs: arrival process, willingness to pay, false-positive
rates, task success,
dispute base rate, repeat interval, agent costs, graph clustering and response-time distribution.
Run parameter sweeps, sensitivity analysis, ablations and intervention experiments—not one favored
parameter set. Reject any policy whose result reverses under a plausible neighborhood of inputs.

## Testnet evidence and limitation

The repository already records a live Base Sepolia “town” of three independently signed agent owners:
paid circular conversations, bond funding and deliberately mined ownership attacks. That is useful
mechanism/integration evidence, not evidence of organic growth or economic equilibrium.

On 2026-09-02 a fresh read-only RPC snapshot was attempted before any new transaction. The public
Base Sepolia endpoint was unreachable from this execution environment (`ENETUNREACH`), and no
`DEPLOYER_PRIVATE_KEY` or `.env` was present. Broadcasting a new “real testnet” economy would therefore
have meant inventing custody or pretending that a local simulation was live. No such claim is made.

When funded test keys and RPC access are available, run this preregistered test:

1. 30 agents in 5 capability clusters; 150 client wallets; 28 days.
2. Randomize clusters among baseline, extraction and regenerative policies.
3. Give every client equal non-withdrawable task credit; agents receive equal initial bond.
4. Agents choose prices and partners from public signals; inject scripted honest, low-quality, Sybil,
   cartel and exit strategies.
5. Settle actual escrow, postage, meter, bond and token-floor transactions on a testnet.
6. Primary outcomes: repeat paid edges, task success, dispute loss, active agents, treasury backing and
   subsidy-adjusted retention. Guardrails: exposure Gini, counterparty concentration, circular flow,
   time-to-first-success and worst-decile client loss.
7. Publish all seeds, agent policies, transaction hashes and null results.

## Build order

1. **Instrument before incentivizing:** event indexer and cohort/graph metrics.
2. **Fix the claim:** RevenuePolicy splitter and obligation-level policy snapshots.
3. **Trust:** domain evidence, diversity caps and post-transfer epochs.
4. **Growth experiment:** credits for matured useful edges; strict budget and kill switch.
5. **Play:** cooperative benchmark seasons and capability badges.
6. **Only then token experiments:** opt-in agent treasuries with clear claims and operating minimums.

The north-star metric should be **90-day, subsidy-adjusted value from repeat, independently settled
client–agent relationships**, constrained by client loss and concentration—not token price, volume,
wallets, streaks or invitations.
