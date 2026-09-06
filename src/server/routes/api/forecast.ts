/**
 * `GET /api/forecast` — the checking balance, twelve months out (#49).
 *
 * A floor projection: recurring income, fixed costs, and known annual/quarterly
 * bills placed in the month they actually land, read entirely from tables a job
 * already wrote. See `domain/aggregate/forecast.ts` for how a bill's timing is
 * detected — this route only shapes its output for the wire.
 */
import type { Db } from '../../../db/index.ts'
import { projectCashflow } from '../../../domain/aggregate/forecast.ts'
import { freshness } from './freshness.ts'
import { forecastSchema, type Forecast } from './schemas.ts'

export function buildForecast(db: Db): Forecast {
  return forecastSchema.parse({
    freshness: freshness(db),
    forecast: projectCashflow(db),
  })
}
