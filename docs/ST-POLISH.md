# SPIDERTAG online refinement

The casual room now runs canonical movement and tag simulation on the relay. Socket identity assigns the slot; clients send quantized controls, never positions or successful-tag claims. Normal keyboard, pad and touch inputs share the same domain. Combined devices are clamped before sampling. Inputs outside ±64 per movement axis, ±100 pitch, or the 41-bit word domain are rejected. Yaw may turn freely: mouse flicks and pad turns are legitimate. The wager referee uses the same domain check; its existing reconstructed-view aim/periodicity evidence remains in place.

Inputs must remain contiguous, inside the horn, and no more than 120 steps ahead of relay time (previously 600). Clock tolerance supports batching and hitches; it does not authorize early results. Both clients must have submitted every step and reached the horn. Matching client hashes alone are insufficient: they must match the canonical referee. Unmatched checkpoint storage is capped at 16 rows. The maximum canonical transcript is two arrays of 72,361 doubles, about 1.10 MiB at the 600-second cap, released when the room empties. Simulation work arrives in at most 128-step packets. Level/index factories cache per district within an isolate.

Admission happens before allocating a room or upgrading a socket. Trusted network identities come from the platform header, with existing canonical address normalization; missing identity fails closed outside development. Separate transactional durable budgets allow six creates with two/minute refill, and sixteen joins with eight/minute refill, across all room codes. A room claim persists for ten minutes across eviction. Idle sockets must say hello within ten seconds. The local adapter additionally caps rooms at 512 and expires unused claims. Admission failures, bad words, step violations, premature results and result mismatches emit detection events without raw network addresses or wallet identities.

Staked create/join attempts additionally consume authenticated-wallet quotas (60/day/action) and relay-network quotas (120/day/action), before RPC work. Public testnets require at least one server-recorded completed series. This is a lightweight history gate, not proof that a human controls the wallet. New accounts need a supervised practice record; there is no new self-service onboarding flow. Development testnets retain their simulation path. Non-testnet match creation and joins are closed. Contracts, deployment configuration and token launch are untouched.

Optional Ed25519 receipts bind room, round, full start message (seed, roster, clock and rules), compatibility, canonical hash and SHA-256 transcript digest. Set the relay secret `RECEIPT_PRIVATE_KEY` to base64 PKCS#8 bytes; verifiers must pin its corresponding base64 SPKI public key, compare the bound match identity with the expected room/round/start, and reject duplicate receipt identities in any consuming application. An unconfigured relay returns no receipt. Clients cannot manufacture one from matching hashes. Receipts do not replace the existing wager replay logs or settlement signatures. The review folder's public key is for the disposable local run only; it is not a production trust anchor.

Transport revision 5 encodes repeated-word input batches once in both directions. The receiver expands the exact original step sequence, including button edges. Signed replay formats and wager simulation identity are unchanged. Deploy client and relays together when eventually authorized. Casual revision-4 peers are refused with the existing reload prompt.

Steady input batching changes from four steps to six, with a 40 ms minimum gap and 50 ms maximum wait. Local prediction still queues two steps at low RTT (16.7 ms at 120 Hz); batching may add 16.7 ms to remote delivery compared with the old four-step batch. Relay nonce probes measure RTT independently of the client's ready message. Room metrics retain input and total byte counts, current probe RTT/jitter EWMA, canonical simulation cost and maximum batch cost; the client probe also exposes jitter. Ordinary render interpolation and rollback stay in place; respawn frames snap instead of interpolating across a fall.

Disconnects cancel casual rounds. The error screen offers REJOIN ROOM, followed by a fresh ready cycle. It does not restore an interrupted competitive result. Existing wager reconnect/log replay behavior remains covered by its tests.

## Repeatable local measurements

`tools/st-net-bench.ts` runs actual sessions and room logic at 120 Hz, over ordered virtual socket links. The fixture is a 20-second match plus three-second countdown, with stable movement and occasional jumps/web presses. Rates divide by those 23 seconds; byte counts include client control/hash messages and exclude WebSocket/TLS framing, pings and receipt output. Jitter is a 30 ms full span around each relay leg, clamped to preserve reliable-socket ordering. Results are deterministic hashes, not claims about a particular geographic route.

| Peer RTT / render fps | Inputs/s before → after | Client B/s before → after | Rollback depth p99 before → after | Stalls after |
| --- | --- | --- | --- | --- |
| 0 ms / 60 | 30 → 20.04 | 975.1 → 375.8 | 1 → 5 | 0 / 0 |
| 100 ms / 60 | 30 → 20.04 | 975.1 → 378.2 | 9 → 13 | 0 / 0 |
| 200 ms / 30 | 29.96 → 15 | 976.4 → 367.7 | 11 → 19 | 0 / 0 |
| 200 ms / 15 | 15 → 15 | 854.3 → 379.6 | 18 → 18 | 0 / 0 |

Compression benefits held/stable input most; constantly changing aim compresses less. Larger batches increase rollback depth, as shown. Both peers finish on identical hashes in every row. In the recorded Node run, canonical simulation averaged approximately 10–42 microseconds/step, maximum individual batch below 3 ms. These CPU values depend on warmup and contention and are not a Worker load test.

The platform documents a 30-second default CPU budget per Durable Object invocation and a 128 MB memory limit: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/). Incremental bounded batches and cached level data are appropriate for this design; concurrency, cold starts, billing, and eviction under production load still need a Worker staging exercise before launch. No deployment was performed.

## Reproduce

Use the local Vite server and `node relay/dev.ts --port 6009 --seed 1025`. The seed flag is only a local repeatability aid. `node tools/st-bot-sim.ts` attacks a localhost relay and then plays a complete normal deterministic input fixture. Its local receipt check reads the review run's public key when present. Use an unseeded relay for ordinary play.

`node tools/st-net-bench.ts after` writes the network table data. `NET_BENCH_ROOT` can select an archived baseline for the `before` run. Review tools write to `~/Documents/spidertag/review/st-polish/`. Browser runs require the shared lock:

```sh
flock -w 3600 ~/.cache/r3g-smoke/browser.lock node tools/st-review.ts after
flock -w 3600 ~/.cache/r3g-smoke/browser.lock node tools/st-menu-review.ts
```

Set `FFMPEG` to an available executable for the clips. `REVIEW_UI` and `REVIEW_RELAY` select the local capture services. Each tool owns one muted headless browser and removes its temporary profile. Gameplay capture throttles software rendering to avoid saturating the shared GPU; clips are encoded at 30 fps, with repeated frames. They are visual evidence, not a hardware frame-time benchmark. A physical controller, real unfolded hardware and production network routes were not tested here.
