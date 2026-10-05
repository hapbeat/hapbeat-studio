import { useEffect, useRef } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { CURRENT_STUDIO_VERSION } from '@/utils/studioVersions'
import { mcpGuideMarkdown, buildCatalog } from '@/utils/agentGuide'
import { localIsoString } from '@/utils/hapticKnowledge'
import { agentResponsePayload, handleAgentRequest, REQUEST_ID, type AgentBridgeDeps } from '@/utils/agentBridge'

function bridgeDeps(): AgentBridgeDeps {
  const agent = useAgentTrialStore.getState
  /** The knowledge folder of the open editor folder (bound by refresh when the folder just changed). */
  const folder = async () => {
    const bound = () => { const current = agent().folder; return current && current.root === useWaveformStore.getState().folder?.root ? current : null }
    if (!bound()) await agent().refresh()
    const current = bound()
    if (!current) throw new Error(agent().error ?? 'The editor folder could not be opened')
    return current
  }
  return {
    studioVersion: CURRENT_STUDIO_VERSION,
    folderName: () => useWaveformStore.getState().folder?.root.name ?? null,
    clipCount: () => useWaveformStore.getState().documents.length,
    loadTrials: async () => (await folder()).listTrials(),
    loadDimensions: async () => (await folder()).readDimensions(),
    readInsights: async () => (await folder()).readInsights(),
    guide: () => mcpGuideMarkdown(CURRENT_STUDIO_VERSION),
    catalog: () => buildCatalog(useWaveformStore.getState().documents, CURRENT_STUDIO_VERSION, localIsoString(new Date())),
    submitTrial: trial => agent().submitTrial(trial),
    // An agent can show a candidate but never starts playback (only the user's ▶ / Space / click does): `play` is ignored.
    audition: async (trialId, candidateId) => {
      // A trial submitted through the inbox moments ago may not be in the store yet.
      if (!agent().trials.some(r => r.trial.id === trialId)) await agent().refresh()
      await agent().requestAudition(trialId, candidateId, false)
    },
    adopt: async (trialId, candidateId) => {
      if (!agent().trials.some(r => r.trial.id === trialId)) await agent().refresh()
      return agent().adoptCandidate(trialId, candidateId)
    },
    appendInsight: (statement, evidence) => agent().appendInsight(statement, evidence),
  }
}

/**
 * Registers this tab as hapbeat-helper's agent endpoint while `enabled` (editor active with a
 * folder open) and the helper is connected, and answers relayed `agent_request`s (MCP tools).
 * Re-registers after a helper reconnect or a folder change.
 */
export function useAgentEndpoint(enabled: boolean, folderName: string | null) {
  const { isConnected, subscribe, send } = useHelperConnection()
  const connected = useRef(isConnected)
  connected.current = isConnected
  useEffect(() => {
    if (!enabled || !isConnected || !folderName) return
    send({ type: 'agent_endpoint_register', payload: { studioVersion: CURRENT_STUDIO_VERSION, folderName } })
    const unsubscribe = subscribe(message => {
      if (message.type !== 'agent_request') return
      const { requestId, method, params } = message.payload
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return
      void handleAgentRequest(method, params, bridgeDeps()).then(response => send({ type: 'agent_response', payload: agentResponsePayload(requestId, response) }))
    })
    return () => {
      unsubscribe()
      // After a disconnect the helper has already dropped this endpoint.
      if (connected.current) send({ type: 'agent_endpoint_unregister', payload: {} })
    }
  }, [enabled, isConnected, folderName, subscribe, send])
}
