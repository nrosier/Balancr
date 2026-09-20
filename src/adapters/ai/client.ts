/** The single provider-neutral network boundary used by the AI domain. */
import type { Db } from '../../db/index.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'
import { callGemini, setGeminiClient } from '../gemini/client.ts'
import type { AiCall, AiResult } from './types.ts'

export async function callAi(db: Db, tenantId: string, call: AiCall): Promise<AiResult> {
  const provider = resolvedIntegrations(db, tenantId).ai.provider
  switch (provider) {
    case 'gemini-aistudio':
    case 'gemini-vertex':
      return callGemini(db, tenantId, call)
  }
}

/** Drop cached provider clients after credentials or provider settings change. */
export function resetAiClients(): void {
  setGeminiClient(null)
}
