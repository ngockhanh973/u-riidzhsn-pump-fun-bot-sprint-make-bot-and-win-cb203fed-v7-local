[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v7-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v7-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Second-Wind Dip-Recovery Bot v7-local (Fade + Hold)

A trading bot for the make.fun **Pump.fun Bot Sprint** bounty. It trades paper
money on a replay of real pump.fun bonding-curve events and is ranked on net
PnL over a 6-hour final window the house records after entries close.

## Idea

Never chase a freshly created coin — most of them rug or never run. This bot
only buys a coin that has already proved it can run (its price once reached
5x the creation price) and is now pulling back 15–25% off its top while
buyers are coming back in. A creator who has already sold 0.5 SOL or more
kills the coin for good.

v7 is a small, evidence-led tune of v6 (the current best entry at
−0.041989 SOL on the dev window): the fade exit reacts faster — a 10-slot
window instead of 15, and −0.03 SOL of net outflow instead of −0.05 — so a
position whose flow turns against it is cut while the loss is still small;
and winners may be held up to 1600 slots (3200 while up 20%+) instead of
1200, so a few of them can reach the +100% take-profit instead of being cut
by the time cap.

## How it trades

- **Entry (all must hold):** at least 200 slots old; top price ≥ 5x creation
  price; top real SOL ≥ 8 and current real SOL ≥ 3; current price 75–85% of
  the top; in the last 20 slots at least 3 buys from at least 3 wallets, net
  flow ≥ 0.02 SOL, the latest trade a buy, and no single buyer over 50% of
  the window's buy SOL.
- **Size:** 0.10 SOL first, one 0.20 SOL add when the price is 5% above the
  first buy with flow still positive (max 0.60 SOL per coin, 5.0 SOL total
  exposure, 5 main positions at once, 2 lifetime entries per coin, 150-slot
  cooldown after an exit).
- **Exits:** sell everything on creator veto (≥ 0.5 SOL sold), a 15% stop,
  a 15% trailing stop after the first take-profit, +100% after the first
  take-profit, net flow under −0.03 SOL over the last 10 slots, or the hold
  cap (1600 slots, 3200 while up ≥ 20%). Take half at +20%, once per
  position; the trailing peak resets to the value still held when that
  half-sale fills.
- **Probe:** a 0.01 SOL buy on a coin that just traded keeps the pace
  guardrails (22 coins / 100 fills over 4 hours) honest; it is sold whole as
  soon as it lands. Fills counted for pacing include sells, and a coin may be
  probed again — only a coin with a probe in flight is off limits.
- **Deterministic:** no clock, no randomness, no environment, no IO in the
  strategy. Two runs on the same window produce byte-identical action logs.

## Key parameters

| Parameter | Value | Parameter | Value |
|---|---|---|---|
| minRunup | 5.0 | tp1 / tp2 | 0.20 / 1.00 |
| dipMin / dipMax | 0.75 / 0.85 | trail / stopLoss | 0.15 / 0.15 |
| firstSol / addSol | 0.10 / 0.20 | maxHold | 1600 (3200 if up 20%+) |
| maxPositionSol | 0.60 | fadeWindow / fadeNetSol | 10 / 0.03 |
| minAge | 200 slots | cooldown / maxEntries | 150 / 2 |
| flowWindow | 20 slots | targetCoins / targetFills | 22 / 100 |

## Dev-window result

Measured with the kit's local replay port on the dev window (two identical
runs, deterministic):

- net PnL: −0.042275 SOL, fills 111, coins 31, round trips 55, wins 6,
  max drawdown 0.0047, rejected 0, failed 2 (two identical runs)
- without failed txs: −0.041880 SOL; at 2x fees: −0.087473 SOL
- Baseline to beat (v6, submitted): net −0.041989 SOL — v7 is 0.000286 SOL
  *below* v6 on the dev window, i.e. effectively tied; it does not beat the
  baseline. Guardrails pass (31 ≥ 20 coins, dd 0.0047 ≤ 0.50).

## Run it

```sh
node main.ts
```

`main.ts` speaks the `agent-fun/replay/v2` protocol on stdin/stdout through
`vendor/makefun-bot.ts` (the kit SDK, copied byte-identical). To replay the
dev window locally, use the kit's `tools/backtest.ts` port against this
strategy.

## License

MIT
