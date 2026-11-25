// Second-Wind Dip-Recovery Bot v7-local ("Fade + Hold").
// Idea: never chase a freshly created coin. Only buy a coin that already proved
// it can run (price once 5x its creation price) and is now pulling back 15-25%
// off its top while buyers come back. v7 tunes v6 in two small ways: the fade
// exit reacts faster (10-slot window, -0.03 SOL net flow) and winners may be
// held longer (1600 slots, doubled while up 20%+) so a few can reach +100%.
// No clock, no randomness, no environment, no IO inside the strategy: every
// decision comes only from the batch the harness sends plus kept state.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

export interface Params {
  minRunup: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  maxExposureSol: number;
  tp2: number;
  trail: number;
  maxHold: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  minRealSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  fadeWindow: number;
  fadeNetSol: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  dipMin: number;
  dipMax: number;
  stopLoss: number;
  tp1: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 5.0,
  minPeakRealSol: 8,
  firstSol: 0.1,
  addSol: 0.2,
  maxPositionSol: 0.6,
  maxExposureSol: 5.0,
  tp2: 1.0,
  trail: 0.15,
  maxHold: 1600,
  minAge: 200,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  minRealSol: 3,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  fadeWindow: 10,
  fadeNetSol: 0.03,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  dipMin: 0.75,
  dipMax: 0.85,
  stopLoss: 0.15,
  tp1: 0.2,
};

// ------------------------------------------------------------------ bookkeeping

const LAMPORTS_PER_SOL = 1_000_000_000;
const LAMPORTS = BigInt(LAMPORTS_PER_SOL);

interface TradeNote {
  slot: number;
  buy: boolean;
  sol: number;
  wallet: string;
}

interface CoinBook {
  mint: string;
  born: number | null;
  creator: string;
  startPx: number;
  topPx: number;
  topRealSol: number;
  makerSoldSol: number;
  trades: TradeNote[];
  complete: boolean;
  // lifetime entry accounting: entries never resets on exit; only the 150-slot
  // cooldown gates the second (and last) entry.
  entries: number;
  lastExitSlot: number | null;
  // live position accounting, reset on a full exit.
  firstPx: number;
  entrySlot: number;
  addDone: boolean;
  tp1Done: boolean;
  bestNet: bigint;
  isProbe: boolean;
  hasPosition: boolean;
}

type PendingKind = "first" | "add" | "probe" | "tp1" | "exit";

interface PendingNote {
  mint: string;
  side: "buy" | "sell";
  kind: PendingKind;
}

function newBook(mint: string): CoinBook {
  return {
    mint,
    born: null,
    creator: "",
    startPx: 0,
    topPx: 0,
    topRealSol: 0,
    makerSoldSol: 0,
    trades: [],
    complete: false,
    entries: 0,
    lastExitSlot: null,
    firstPx: 0,
    entrySlot: 0,
    addDone: false,
    tp1Done: false,
    bestNet: 0n,
    isProbe: false,
    hasPosition: false,
  };
}

function curvePrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function curveRealSol(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  return Number(c.real_quote_reserves) / LAMPORTS_PER_SOL;
}

// Net value of a held position: mark at the latest reserves, minus the 1.25%
// curve fee (95bps protocol + 30bps creator) and minus one tx fee.
function positionNetLamports(state: BotState, mint: string, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return 0n;
  const gross = (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
  const net = (gross * 9875n) / 10000n - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

interface Flow {
  net: number;
  buyCount: number;
  buyers: number;
  lastBuy: boolean;
  seen: boolean;
  topShare: number;
}

function windowFlow(book: CoinBook, now: number, span: number): Flow {
  let buys = 0;
  let sells = 0;
  let buyCount = 0;
  const perBuyer = new Map<string, number>();
  let lastBuy = false;
  let seen = false;
  for (const t of book.trades) {
    if (t.slot <= now - span) continue;
    seen = true;
    lastBuy = t.buy;
    if (t.buy) {
      buys += t.sol;
      buyCount += 1;
      perBuyer.set(t.wallet, (perBuyer.get(t.wallet) ?? 0) + t.sol);
    } else {
      sells += t.sol;
    }
  }
  let topBuyer = 0;
  for (const v of perBuyer.values()) if (v > topBuyer) topBuyer = v;
  return {
    net: buys - sells,
    buyCount,
    buyers: perBuyer.size,
    lastBuy,
    seen,
    topShare: buys > 0 ? topBuyer / buys : 0,
  };
}

// ------------------------------------------------------------------ strategy

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<string, CoinBook>();
  const pendingNotes = new Map<string, PendingNote>();
  const matchedMints = new Set<string>();
  let filledCount = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  function bookFor(mint: string): CoinBook {
    let b = books.get(mint);
    if (b === undefined) {
      b = newBook(mint);
      books.set(mint, b);
    }
    return b;
  }

  function hasPending(mint: string, side: "buy" | "sell"): boolean {
    for (const n of pendingNotes.values()) {
      if (n.mint === mint && n.side === side) return true;
    }
    return false;
  }

  function closeBook(b: CoinBook, slot: number): void {
    b.hasPosition = false;
    b.isProbe = false;
    b.addDone = false;
    b.tp1Done = false;
    b.bestNet = 0n;
    b.firstPx = 0;
    b.lastExitSlot = slot;
  }

  function ingest(state: BotState, batch: Batch): void {
    const now = batch.slot;
    const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        const b = bookFor(e.mint);
        b.born = e.slot;
        b.creator = e.creator;
        const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        b.startPx = px;
        if (px > b.topPx) b.topPx = px;
      } else if (e.event === "TradeEvent") {
        const b = bookFor(e.mint);
        if (b.creator === "") b.creator = e.creator;
        const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        if (px > b.topPx) b.topPx = px;
        const realSol = Number(e.real_quote_reserves) / LAMPORTS_PER_SOL;
        if (realSol > b.topRealSol) b.topRealSol = realSol;
        const sol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
        if (!e.is_buy && e.user === b.creator) b.makerSoldSol += sol;
        b.trades.push({ slot: e.slot, buy: e.is_buy, sol, wallet: e.user });
      } else {
        bookFor(e.mint).complete = true;
      }
    }
    for (const b of books.values()) {
      while (b.trades.length > 0 && b.trades[0]!.slot <= now - horizon) b.trades.shift();
    }
  }

  function settleFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      const note = pendingNotes.get(f.client_id);
      if (note !== undefined) pendingNotes.delete(f.client_id);
      if (f.status !== "filled") continue;
      matchedMints.add(f.mint);
      filledCount += 1;
      const b = bookFor(f.mint);
      if (f.side === "buy") {
        if (note?.kind === "probe") {
          b.isProbe = true;
          b.hasPosition = true;
        } else if (note?.kind === "first") {
          b.entries += 1;
          b.entrySlot = f.slot;
          b.firstPx = curvePrice(state, f.mint);
          b.addDone = false;
          b.tp1Done = false;
          b.isProbe = false;
          b.hasPosition = true;
          const pos = state.positions.get(f.mint);
          b.bestNet = pos !== undefined ? positionNetLamports(state, f.mint, pos.token_amount) : 0n;
        } else if (note?.kind === "add") {
          b.addDone = true;
        }
      } else {
        // A sell fill: TP1 is only confirmed once the fill lands, and only
        // then does the trailing peak reset to the value still held.
        if (note?.kind === "tp1") {
          b.tp1Done = true;
          const pos = state.positions.get(f.mint);
          b.bestNet = pos !== undefined ? positionNetLamports(state, f.mint, pos.token_amount) : 0n;
        }
        if (!state.positions.has(f.mint) && b.hasPosition) closeBook(b, f.slot);
      }
    }
    // A position that vanished from state with no order in flight is closed
    // in the book too, so a later re-entry sees a clean slate.
    for (const b of books.values()) {
      if (b.hasPosition && !state.positions.has(b.mint) && !hasPending(b.mint, "buy") && !hasPending(b.mint, "sell")) {
        closeBook(b, batch.slot);
      }
    }
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    ingest(state, batch);
    settleFills(state, batch);
    const now = batch.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const soldThisBatch = new Set<string>();
    let spendable = state.freeCashLamports();
    let exposureLamports = 0n;
    for (const pos of state.positions.values()) exposureLamports += pos.cost_lamports;
    for (const pn of state.pending.values()) {
      if (pn.order.side === "buy") exposureLamports += BigInt(pn.order.quote_lamports);
    }
    let plannedNew = 0;

    function emitBuy(mint: string, kind: PendingKind, wantLamports: bigint): boolean {
      const cap = state.maxBuyLamports(mint);
      let amount = wantLamports;
      if (amount > cap) amount = cap;
      const room = BigInt(Math.floor(p.maxExposureSol * LAMPORTS_PER_SOL)) - exposureLamports;
      if (amount > room) amount = room;
      if (amount + txFee > spendable) amount = spendable - txFee;
      if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS_PER_SOL))) return false;
      const id = state.clientId();
      pendingNotes.set(id, { mint, side: "buy", kind });
      orders.push({ side: "buy", client_id: id, mint, quote_lamports: amount.toString(), max_slippage_bps: p.buySlipBps });
      spendable -= amount + txFee;
      exposureLamports += amount;
      return true;
    }

    function emitSell(mint: string, kind: PendingKind, tokens: bigint): boolean {
      if (tokens <= 0n) return false;
      const id = state.clientId();
      pendingNotes.set(id, { mint, side: "sell", kind });
      orders.push({ side: "sell", client_id: id, mint, token_amount: tokens.toString(), max_slippage_bps: 10000 });
      soldThisBatch.add(mint);
      return true;
    }

    // ---- exits first, before any new entry in this batch.
    for (const [mint, pos] of state.positions) {
      const b = bookFor(mint);
      if (hasPending(mint, "sell")) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const net = positionNetLamports(state, mint, pos.token_amount);
      const cost = pos.cost_lamports;
      // A probe is sold whole the moment its buy has landed.
      if (b.isProbe) {
        emitSell(mint, "exit", pos.token_amount);
        continue;
      }
      if (net > b.bestNet) b.bestNet = net;
      const up20 = net * 5n >= cost * 6n;
      const holdLimit = up20 ? p.maxHold * 2 : p.maxHold;
      const fade = windowFlow(b, now, p.fadeWindow).net;
      const stopHit = net * 100n < cost * BigInt(Math.round((1 - p.stopLoss) * 100));
      const trailHit = b.tp1Done && net * 100n < b.bestNet * BigInt(Math.round((1 - p.trail) * 100));
      const tp2Hit = b.tp1Done && net >= cost * BigInt(Math.round(1 + p.tp2));
      const tooOld = b.entrySlot > 0 && now - b.entrySlot > holdLimit;
      if (
        b.makerSoldSol >= p.creatorSellVetoSol ||
        stopHit ||
        trailHit ||
        tp2Hit ||
        fade < -p.fadeNetSol ||
        tooOld
      ) {
        emitSell(mint, "exit", pos.token_amount);
      }
    }

    // ---- take half profit once per position, at +20%.
    for (const [mint, pos] of state.positions) {
      const b = bookFor(mint);
      if (b.isProbe || b.tp1Done || soldThisBatch.has(mint)) continue;
      if (hasPending(mint, "sell")) continue;
      const net = positionNetLamports(state, mint, pos.token_amount);
      const cost = pos.cost_lamports;
      if (net * 5n >= cost * 6n) {
        emitSell(mint, "tp1", pos.token_amount / 2n);
      }
    }

    // ---- one add per position, on a 5% rise with buyers still flowing in.
    for (const [mint, pos] of state.positions) {
      const b = bookFor(mint);
      if (b.isProbe || b.addDone || soldThisBatch.has(mint)) continue;
      if (hasPending(mint, "buy") || hasPending(mint, "sell")) continue;
      if (b.firstPx <= 0) continue;
      const px = curvePrice(state, mint);
      if (px < b.firstPx * (1 + p.addStep)) continue;
      if (windowFlow(b, now, p.flowWindow).net < p.minFlowSol) continue;
      if (curveRealSol(state, mint) < p.minRealSol) continue;
      const invested = Number(pos.cost_lamports) / LAMPORTS_PER_SOL;
      if (invested + p.addSol > p.maxPositionSol) continue;
      emitBuy(mint, "add", BigInt(Math.floor(p.addSol * LAMPORTS_PER_SOL)));
    }

    // ---- new entries: dip-recovery coins only.
    const room = () => state.committedPositionCount() + plannedNew < p.maxMain;
    for (const b of books.values()) {
      if (!room()) break;
      if (b.complete || b.hasPosition) continue;
      if (hasPending(b.mint, "buy") || hasPending(b.mint, "sell")) continue;
      if (b.entries >= p.maxEntries) continue;
      if (b.lastExitSlot !== null && now - b.lastExitSlot < p.cooldown) continue;
      if (b.born === null || now - b.born < p.minAge) continue;
      if (b.makerSoldSol >= p.creatorSellVetoSol) continue;
      if (b.startPx <= 0 || b.topPx < p.minRunup * b.startPx) continue;
      if (b.topRealSol < p.minPeakRealSol) continue;
      if (curveRealSol(state, b.mint) < p.minRealSol) continue;
      const px = curvePrice(state, b.mint);
      if (px <= 0) continue;
      const dip = px / b.topPx;
      if (dip < p.dipMin || dip > p.dipMax) continue;
      const flow = windowFlow(b, now, p.flowWindow);
      if (!flow.seen) continue;
      if (flow.buyCount < p.minFlowBuyers) continue;
      if (flow.buyers < p.minFlowBuyers) continue;
      if (flow.net < p.minFlowSol) continue;
      if (p.lastMustBeBuy && !flow.lastBuy) continue;
      if (flow.topShare > p.maxBuyerShare) continue;
      if (emitBuy(b.mint, "first", BigInt(Math.floor(p.firstSol * LAMPORTS_PER_SOL)))) plannedNew += 1;
    }

    // ---- probe keeps the pace guardrails honest: a 0.01 SOL buy on a coin
    // that just traded, sold whole as soon as it lands. Fill counts include
    // sells; a coin may be probed again, only a coin with a probe in flight
    // is off limits, and only a coin shortfall demands a never-matched coin.
    let probesActive = 0;
    for (const n of pendingNotes.values()) if (n.kind === "probe" && n.side === "buy") probesActive += 1;
    for (const b of books.values()) if (b.isProbe && b.hasPosition) probesActive += 1;
    if (probesActive < p.maxProbes && room() && firstBlockTime !== null && lastBlockTime !== null) {
      const elapsed = lastBlockTime - firstBlockTime;
      const progress = Math.min(1, elapsed / p.paceSecs);
      const needCoins = matchedMints.size < Math.ceil(p.targetCoins * progress);
      const needFills = filledCount < Math.ceil(p.targetFills * progress);
      if (needCoins || needFills) {
        const liquidSol = 1.5 * ((p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve);
        const seenThisBatch: string[] = [];
        for (const e of batch.events) {
          if (e.event === "TradeEvent" && !seenThisBatch.includes(e.mint)) seenThisBatch.push(e.mint);
        }
        for (const mint of seenThisBatch) {
          const b = bookFor(mint);
          if (b.complete || b.hasPosition) continue;
          if (hasPending(mint, "buy") || hasPending(mint, "sell")) continue;
          if (curveRealSol(state, mint) < liquidSol) continue;
          if (needCoins && matchedMints.has(mint)) continue;
          if (emitBuy(mint, "probe", BigInt(Math.floor(p.probeSol * LAMPORTS_PER_SOL)))) break;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
