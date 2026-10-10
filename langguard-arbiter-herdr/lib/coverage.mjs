export const ARBITER_HARNESSES = Object.freeze(
  Object.assign(Object.create(null), {
    claude: {
      harness: 'claude',
      install: [
        'claude plugin marketplace add LangGuard-AI/langguard-plugins',
        'claude plugin install langguard-arbiter@langguard-plugins',
      ],
    },
    codex: {
      harness: 'codex',
      install: [
        'codex plugin marketplace add LangGuard-AI/langguard-plugins',
        'codex plugin install langguard-arbiter',
      ],
    },
    cursor: {
      harness: 'cursor',
      install: [
        'Open the Cursor plugin marketplace and install the LangGuard Arbiter plugin. Cursor has no command line installer.',
      ],
    },
    agy: {
      harness: 'antigravity',
      install: ['agy plugin install LangGuard-AI/langguard-plugins/langguard-arbiter-antigravity'],
    },
    antigravity: {
      harness: 'antigravity',
      install: ['agy plugin install LangGuard-AI/langguard-plugins/langguard-arbiter-antigravity'],
    },
  }),
);

export function coverageFor(agentLabel) {
  if (typeof agentLabel !== 'string') return { supported: false };
  if (!Object.hasOwn(ARBITER_HARNESSES, agentLabel)) return { supported: false };
  const entry = ARBITER_HARNESSES[agentLabel];
  return { supported: true, harness: entry.harness, install: [...entry.install] };
}
