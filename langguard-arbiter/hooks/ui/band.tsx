import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import { BAND, COUNT_GAP, LEFT_GAP, PRESENCE, bandOf, isDegraded } from './status.ts'

const HEALTH = { plugin: 'langguard-arbiter', key: 'health' } as const
const LEDGER = { plugin: 'langguard-arbiter', key: 'ledger' } as const

// L2 flips only this constant.
export const BAND_ALWAYS_VISIBLE = false

export const drawBand = async ($: EngineInterface, e: RenderInput<'AbovePrompt'>, next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>): Promise<RenderElement> => {
  if (e.props.hasSurvey) return next(e)
  const engine = await next(e)
  const health = (await $.state.get(HEALTH)).value
  const ledger = (await $.state.get(LEDGER)).value
  const band = bandOf(health, ledger, e.props.bodyColumns, BAND_ALWAYS_VISIBLE)
  if (band === null) return engine
  const { Box, Button, Text } = $.ui.resolve(e)
  const action = band.action
  return (
    <Box flexDirection="column">
      {engine}
      <Box key="band" flexDirection="row" justifyContent="space-between">
        <Text>
          {` ${BAND.brand}${LEFT_GAP}`}
          {band.degraded ? (
            <Text key="band.state" color="warning" bold>
              {band.word}
            </Text>
          ) : (
            <Text key="band.state">{band.word}</Text>
          )}
          {band.counts.map(count => (
            <Text key={count.key}>
              {COUNT_GAP}
              <Text color={count.color} bold={count.bold}>
                {count.text}
              </Text>
            </Text>
          ))}
        </Text>
        {action === null ? null : <Button key="band.action" label={action} plain onPress={() => void $.command.run({ command: 'langguard', args: band.degraded ? 'status' : '' }).catch(() => {})} />}
      </Box>
    </Box>
  )
}

export const drawPresence = async ($: EngineInterface, e: RenderInput<'SessionMode'>, next: (e: RenderInput<'SessionMode'>) => Promise<RenderElement>): Promise<RenderElement> => {
  const health = (await $.state.get(HEALTH)).value
  if (isDegraded(health?.reasons ?? [])) return next(e)
  return next({ ...e, props: { ...e.props, modes: [...e.props.modes, PRESENCE] } })
}
