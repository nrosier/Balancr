/**
 * `GET /api/scenario` — the real seed values for the what-if calculator (#51).
 *
 * Only the baseline is computed here. The projection itself (`projectScenario`) is
 * pure and re-exported to the browser through `web/src/shared.ts`, so the page
 * recomputes it locally as the user edits amount, horizon or growth rate — no
 * request per interaction. See `domain/aggregate/scenario.ts` for both.
 */
import type { Db } from '../../../db/index.ts'
import { scenarioBaseline } from '../../../domain/aggregate/scenario.ts'
import { freshness } from './freshness.ts'
import { scenarioSchema, type Scenario } from './schemas.ts'

export function buildScenario(db: Db): Scenario {
  return scenarioSchema.parse({
    freshness: freshness(db),
    scenario: scenarioBaseline(db),
  })
}
