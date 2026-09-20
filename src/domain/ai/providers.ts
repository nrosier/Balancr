/** Provider identities are stable persistence keys, not display labels. */
export const AI_PROVIDERS = [
  'gemini-aistudio',
  'gemini-vertex',
  'openai',
  'xai',
  'openai-compatible',
] as const

export type AiProvider = (typeof AI_PROVIDERS)[number]
