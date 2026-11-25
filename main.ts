import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy, DEFAULT_PARAMS } from "./strategy.ts";

const bot = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
  onDone(state, done) {
    console.error(`done reason=${done.reason} cash=${state.cash} positions=${state.positions.size} curves=${state.curves.size}`);
  },
});
