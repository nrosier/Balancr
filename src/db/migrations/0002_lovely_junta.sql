CREATE VIEW `ai_spend_monthly` AS select
    strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch') as month,
    count(*) as run_count,
    coalesce(sum(ai_runs.input_tokens), 0) as input_tokens,
    coalesce(sum(ai_runs.output_tokens), 0) as output_tokens,
    coalesce(sum(ai_runs.cached_tokens), 0) as cached_tokens,
    coalesce(sum(ai_runs.cost_micro_eur), 0) as cost_micro_eur
  from ai_runs
  group by strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch');